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

async function handleLog(request, env, headers) {
  let body;
  try {
    body = await request.json();
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

  const notionRes = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { database_id: env.NOTION_DATABASE_ID },
      properties,
    }),
  });

  if (!notionRes.ok) {
    const detail = await notionRes.text();
    return json({ error: "Notion write failed", detail }, 502, headers);
  }

  const page = await notionRes.json();
  return json({ ok: true, id: page.id }, 200, headers);
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
          { property: "Set Number", direction: "ascending" },
        ],
        page_size: 100,
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

    return json({ error: "Not found" }, 404, headers);
  },
};
