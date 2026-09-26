const NOTION_VERSION = "2022-06-28";

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

// A set normally arrives as JSON. A Week 0 set that carries machine photos
// arrives as multipart (a `payload` JSON field plus `photos` files), so the
// Worker can hand the files to Notion untouched instead of decoding base64.
async function readLogRequest(request) {
  const type = request.headers.get("Content-Type") || "";
  if (type.includes("multipart/form-data")) {
    const form = await request.formData();
    const body = JSON.parse(form.get("payload"));
    const photos = form.getAll("photos").filter((f) => typeof f !== "string" && f.size > 0);
    return { body, photos };
  }
  return { body: await request.json(), photos: [] };
}

async function handleLog(request, env, headers) {
  let body;
  let photos;
  try {
    ({ body, photos } = await readLogRequest(request));
  } catch {
    return json({ error: "Invalid JSON" }, 400, headers);
  }

  const { date, exercise, week, phase, setNumber, targetWeight, targetReps, actualWeight, reps, notes } = body;

  if (!date || !exercise || !week || !phase || setNumber == null || actualWeight == null || reps == null) {
    return json({ error: "Missing required field" }, 400, headers);
  }

  const title = `${date} - ${exercise} - ${phase}`;

  const properties = {
    Name: { title: [{ text: { content: title } }] },
    Date: { date: { start: date } },
    Exercise: { select: { name: exercise } },
    Week: { select: { name: week } },
    Phase: { select: { name: phase } },
    "Set Number": { number: Number(setNumber) },
    "Actual Weight": { number: Number(actualWeight) },
    Reps: { number: Number(reps) },
  };

  if (targetWeight != null && targetWeight !== "") {
    properties["Target Weight"] = { number: Number(targetWeight) };
  }
  if (targetReps) {
    properties["Target Reps"] = { rich_text: [{ text: { content: String(targetReps).slice(0, 200) } }] };
  }
  if (notes) {
    properties.Notes = { rich_text: [{ text: { content: String(notes).slice(0, 2000) } }] };
  }

  // Grip, the library link and the day's Workouts row are extras. Logging the set
  // itself must never fail because of them, so every lookup fails soft.
  const links = await lookupLinks(env, date, exercise);
  const extras = {};
  const grip = gripFromPhase(phase);
  if (grip) extras.Grip = { select: { name: grip } };
  if (links.exerciseId) extras["Exercise Link"] = { relation: [{ id: links.exerciseId }] };
  if (links.workoutId) extras.Workout = { relation: [{ id: links.workoutId }] };

  let notionRes = await createLogPage(env, { ...properties, ...extras });
  let linked = true;
  if (!notionRes.ok) {
    // Retry once without the extras in case Notion rejected one of them.
    notionRes = await createLogPage(env, properties);
    linked = false;
  }

  if (!notionRes.ok) {
    const detail = await notionRes.text();
    return json({ error: "Notion write failed", detail }, 502, headers);
  }

  const page = await notionRes.json();

  // Machine photos are an extra too: the set is already saved, so a failed
  // upload only lowers `photosAttached`, it never turns the log into an error.
  const photosSent = Math.min(photos.length, MAX_PHOTOS);
  const photosAttached = photosSent ? await attachPhotos(env, page.id, photos, `${date} ${exercise}`) : 0;

  return json(
    {
      ok: true,
      id: page.id,
      linked,
      exerciseLinked: linked && !!links.exerciseId,
      workoutLinked: linked && !!links.workoutId,
      photosSent,
      photosAttached,
    },
    200,
    headers
  );
}

const MAX_PHOTOS = 3;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

async function uploadPhoto(env, file, filename) {
  if (file.size > MAX_PHOTO_BYTES) throw new Error("photo too large");
  const contentType = /^image\//.test(file.type) ? file.type : "image/jpeg";

  const create = await fetch("https://api.notion.com/v1/file_uploads", {
    method: "POST",
    headers: notionHeaders(env),
    body: JSON.stringify({ filename, content_type: contentType }),
    signal: AbortSignal.timeout(8000),
  });
  if (!create.ok) throw new Error(`file_uploads create ${create.status}`);
  const { id } = await create.json();

  const form = new FormData();
  form.append("file", file, filename);
  const send = await fetch(`https://api.notion.com/v1/file_uploads/${id}/send`, {
    method: "POST",
    // No Content-Type here: fetch sets the multipart boundary itself.
    headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": NOTION_VERSION },
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  if (!send.ok) throw new Error(`file_uploads send ${send.status}`);
  return { id, filename };
}

// Returns how many photos ended up attached to the set's Photos property.
async function attachPhotos(env, pageId, photos, label) {
  const slug = label.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "machine";
  const uploaded = [];
  for (const [i, file] of photos.slice(0, MAX_PHOTOS).entries()) {
    try {
      uploaded.push(await uploadPhoto(env, file, `${slug}-${i + 1}.jpg`));
    } catch {
      // skip this photo
    }
  }
  if (!uploaded.length) return 0;

  try {
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "PATCH",
      headers: notionHeaders(env),
      body: JSON.stringify({
        properties: {
          Photos: {
            files: uploaded.map((u) => ({ type: "file_upload", file_upload: { id: u.id }, name: u.filename })),
          },
        },
      }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok ? uploaded.length : 0;
  } catch {
    return 0;
  }
}

function notionHeaders(env) {
  return {
    Authorization: `Bearer ${env.NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

function createLogPage(env, properties) {
  return fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: notionHeaders(env),
    body: JSON.stringify({
      parent: { database_id: env.NOTION_DATABASE_ID },
      properties,
    }),
  });
}

function gripFromPhase(phase) {
  if (/\(Outer\)$/.test(phase)) return "Outer";
  if (/\(Inner\)$/.test(phase)) return "Inner";
  return null; // single-grip rows leave Grip blank, matching the backfill
}

const WORKOUT_LABELS = {
  "Chest and Back": "Chest and Back",
  "Shoulders/Bi's & Tri's": "Shoulders, Biceps and Triceps",
  Legs: "Legs",
};

// Returns the first matching page, null when nothing matches, and throws on any failure.
async function queryFirst(env, databaseId, filter) {
  const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
    method: "POST",
    headers: notionHeaders(env),
    body: JSON.stringify({ filter, page_size: 1 }),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`query ${res.status}`);
  const data = await res.json();
  return data.results?.[0] ?? null;
}

async function createWorkoutRow(env, date, category) {
  const label = WORKOUT_LABELS[category];
  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: notionHeaders(env),
    body: JSON.stringify({
      parent: { database_id: env.WORKOUTS_DATABASE_ID },
      properties: {
        Name: { title: [{ text: { content: `Workout ${date}${label ? ` (${label})` : ""}` } }] },
        Date: { date: { start: date } },
      },
    }),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`create ${res.status}`);
  return (await res.json()).id;
}

async function lookupLinks(env, date, exercise) {
  const out = { exerciseId: null, workoutId: null };
  if (!env.EXERCISE_LIBRARY_DATABASE_ID || !env.WORKOUTS_DATABASE_ID) return out;

  const soft = (promise) => promise.catch(() => undefined);
  const [library, workout] = await Promise.all([
    soft(queryFirst(env, env.EXERCISE_LIBRARY_DATABASE_ID, { property: "Name", title: { equals: exercise } })),
    soft(queryFirst(env, env.WORKOUTS_DATABASE_ID, { property: "Date", date: { equals: date } })),
  ]);

  if (library) out.exerciseId = library.id;

  // undefined means the lookup failed, so do not risk creating a duplicate day row.
  if (workout) {
    out.workoutId = workout.id;
  } else if (workout === null) {
    try {
      out.workoutId = await createWorkoutRow(env, date, library?.properties?.Category?.select?.name);
    } catch {
      // leave unlinked
    }
  }
  return out;
}

async function handleEmailReport(request, env, headers) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400, headers);
  }

  const { date, filename, pdfBase64 } = body;
  if (!date || !filename || !pdfBase64) {
    return json({ error: "Missing required field" }, 400, headers);
  }

  const emailRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Workout Log <onboarding@resend.dev>",
      to: ["chrisflure@gmail.com"],
      subject: `Workout Log — ${date}`,
      text: `Your workout log for ${date} is attached.`,
      attachments: [{ filename, content: pdfBase64 }],
    }),
  });

  if (!emailRes.ok) {
    const detail = await emailRes.text();
    return json({ error: "Email send failed", detail }, 502, headers);
  }

  return json({ ok: true }, 200, headers);
}

async function handleToday(request, env, headers) {
  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  if (!date) {
    return json({ error: "Missing date query param" }, 400, headers);
  }

  const notionRes = await fetch(
    `https://api.notion.com/v1/databases/${env.NOTION_DATABASE_ID}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: { property: "Date", date: { equals: date } },
        sorts: [{ timestamp: "created_time", direction: "ascending" }],
      }),
    }
  );

  if (!notionRes.ok) {
    const detail = await notionRes.text();
    return json({ error: "Notion query failed", detail }, 502, headers);
  }

  const data = await notionRes.json();
  const rows = (data.results || []).map(rowFromPage);
  return json({ rows }, 200, headers);
}

function rowFromPage(page) {
  const p = page.properties;
  return {
    date: p.Date?.date?.start ?? null,
    exercise: p.Exercise?.select?.name ?? null,
    week: p.Week?.select?.name ?? null,
    phase: p.Phase?.select?.name ?? null,
    setNumber: p["Set Number"]?.number ?? null,
    targetWeight: p["Target Weight"]?.number ?? null,
    targetReps: p["Target Reps"]?.rich_text?.[0]?.plain_text ?? "",
    actualWeight: p["Actual Weight"]?.number ?? null,
    reps: p.Reps?.number ?? null,
    notes: p.Notes?.rich_text?.[0]?.plain_text ?? "",
  };
}

async function handleRange(request, env, headers) {
  const url = new URL(request.url);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if (!start || !end) {
    return json({ error: "Missing start/end query params" }, 400, headers);
  }

  const rows = [];
  let cursor = undefined;
  for (let page = 0; page < 5; page++) {
    const notionRes = await fetch(
      `https://api.notion.com/v1/databases/${env.NOTION_DATABASE_ID}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.NOTION_TOKEN}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filter: {
            and: [
              { property: "Date", date: { on_or_after: start } },
              { property: "Date", date: { on_or_before: end } },
            ],
          },
          sorts: [
            { property: "Date", direction: "ascending" },
            { timestamp: "created_time", direction: "ascending" },
          ],
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
      }
    );

    if (!notionRes.ok) {
      const detail = await notionRes.text();
      return json({ error: "Notion query failed", detail }, 502, headers);
    }

    const data = await notionRes.json();
    rows.push(...(data.results || []).map(rowFromPage));
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }

  return json({ rows }, 200, headers);
}

async function handleHistory(request, env, headers) {
  const url = new URL(request.url);
  const exercise = url.searchParams.get("exercise");
  if (!exercise) {
    return json({ error: "Missing exercise query param" }, 400, headers);
  }

  const rows = [];
  let cursor = undefined;
  for (let page = 0; page < 5; page++) {
    const notionRes = await fetch(
      `https://api.notion.com/v1/databases/${env.NOTION_DATABASE_ID}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.NOTION_TOKEN}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filter: { property: "Exercise", select: { equals: exercise } },
          sorts: [
            { property: "Date", direction: "ascending" },
            { property: "Set Number", direction: "ascending" },
          ],
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
      }
    );

    if (!notionRes.ok) {
      const detail = await notionRes.text();
      return json({ error: "Notion query failed", detail }, 502, headers);
    }

    const data = await notionRes.json();
    for (const page of data.results || []) {
      const p = page.properties;
      rows.push({
        date: p.Date?.date?.start ?? null,
        week: p.Week?.select?.name ?? null,
        phase: p.Phase?.select?.name ?? null,
      });
    }
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }

  return json({ rows }, 200, headers);
}

export default {
  async fetch(request, env) {
    const headers = cors();

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    const url = new URL(request.url);

    if (url.pathname === "/log" && request.method === "POST") {
      return handleLog(request, env, headers);
    }
    if (url.pathname === "/today" && request.method === "GET") {
      return handleToday(request, env, headers);
    }
    if (url.pathname === "/range" && request.method === "GET") {
      return handleRange(request, env, headers);
    }
    if (url.pathname === "/history" && request.method === "GET") {
      return handleHistory(request, env, headers);
    }
    if (url.pathname === "/email-report" && request.method === "POST") {
      return handleEmailReport(request, env, headers);
    }

    return json({ error: "Not found" }, 404, headers);
  },
};
