const NOTION_VERSION = "2022-06-28";

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
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

  const { date, exercise, week, setNumber, targetWeight, actualWeight, reps, notes } = body;

  if (!date || !exercise || !week || setNumber == null || actualWeight == null || reps == null) {
    return json({ error: "Missing required field" }, 400, headers);
  }

  const title = `${date} - ${exercise} - Set ${setNumber}`;

  const properties = {
    Name: { title: [{ text: { content: title } }] },
    Date: { date: { start: date } },
    Exercise: { select: { name: exercise } },
    Week: { select: { name: week } },
    "Set Number": { number: Number(setNumber) },
    "Actual Weight": { number: Number(actualWeight) },
    Reps: { number: Number(reps) },
  };

  if (targetWeight != null && targetWeight !== "") {
    properties["Target Weight"] = { number: Number(targetWeight) };
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
        sorts: [{ property: "Set Number", direction: "ascending" }],
      }),
    }
  );

  if (!notionRes.ok) {
    const detail = await notionRes.text();
    return json({ error: "Notion query failed", detail }, 502, headers);
  }

  const data = await notionRes.json();
  const rows = (data.results || []).map((page) => {
    const p = page.properties;
    return {
      exercise: p.Exercise?.select?.name ?? null,
      week: p.Week?.select?.name ?? null,
      setNumber: p["Set Number"]?.number ?? null,
      targetWeight: p["Target Weight"]?.number ?? null,
      actualWeight: p["Actual Weight"]?.number ?? null,
      reps: p.Reps?.number ?? null,
      notes: p.Notes?.rich_text?.[0]?.plain_text ?? "",
    };
  });

  return json({ rows }, 200, headers);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const headers = cors(origin);

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

    return json({ error: "Not found" }, 404, headers);
  },
};
