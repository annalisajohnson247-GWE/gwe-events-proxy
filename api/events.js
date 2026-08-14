// api/events.js
const GHL_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";
const PIPELINE_NAME = "Event Requests";
const APPROVED_STAGE_NAME = "Approved";

// Opportunity custom field IDs, hardcoded and verified character-by-character
// against real records. GHL's API has no working endpoint to list
// Opportunity-level custom field definitions, so these were read directly
// off a live opportunity. IDs are permanent unless a field is deleted and
// recreated from scratch.
const FIELD_IDS = {
  event_name: "aRhl6N9b5RVYr2JwCExF",
  event_type: "icoC1eZHZg61RQrJhfni",
  event_date: "M37qBoXrRB4fzBUlNvIe",
  start_time: "3vBH6RNIjjhoZJuoqkh4",
  end_time: "Bwz6MwBc4upEsXoPFgnl",
  real_location__address: "gj7tr1JJFc3siNy3J9SE",
  public_location_label: "rIxuaszjHEspjIOJ0Hmk",
  prep_notes__what_to_bring: "bycoh2snbaeMyyyNIWlU",
  ticket_price: "uechl93Ol4u99BlarbeS",
  purchase_link: "c2qugZJBIl4w3LfD2PQp",
  max_attendees: "AnMzsPUueUUP8JQp8fAo",
  city: "bowkqeQh2AMCUwsSblIc",
};
const ID_TO_KEY = Object.fromEntries(Object.entries(FIELD_IDS).map(([k, v]) => [v, k]));

function ghlHeaders() {
  return {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    Version: API_VERSION,
    Accept: "application/json",
  };
}

let stageCache = { pipelineId: null, stageId: null, expires: 0 };
const ONE_HOUR = 60 * 60 * 1000;

async function getApprovedStageId(locationId) {
  if (stageCache.stageId && stageCache.expires > Date.now()) {
    return { pipelineId: stageCache.pipelineId, stageId: stageCache.stageId };
  }
  const res = await fetch(`${GHL_BASE}/opportunities/pipelines?locationId=${locationId}`, {
    headers: ghlHeaders(),
  });
  if (!res.ok) throw new Error(`Pipelines lookup failed: ${res.status}`);
  const data = await res.json();
  const pipeline = (data.pipelines || []).find(
    (p) => (p.name || "").trim().toLowerCase() === PIPELINE_NAME.toLowerCase()
  );
  if (!pipeline) throw new Error(`Pipeline "${PIPELINE_NAME}" not found`);
  const stage = (pipeline.stages || []).find(
    (s) => (s.name || "").trim().toLowerCase() === APPROVED_STAGE_NAME.toLowerCase()
  );
  if (!stage) throw new Error(`Stage "${APPROVED_STAGE_NAME}" not found`);
  stageCache = { pipelineId: pipeline.id, stageId: stage.id, expires: Date.now() + ONE_HOUR };
  return { pipelineId: pipeline.id, stageId: stage.id };
}

function extractCustomFieldValue(entry) {
  if (entry.fieldValue !== undefined && entry.fieldValue !== null) {
    return typeof entry.fieldValue === "number" ? String(entry.fieldValue) : entry.fieldValue;
  }
  if (entry.fieldValueString !== undefined) return entry.fieldValueString;
  if (entry.fieldValueNumber !== undefined) return String(entry.fieldValueNumber);
  if (entry.fieldValueDate !== undefined) {
    const d = new Date(entry.fieldValueDate);
    return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  }
  return "";
}

function classifyEventType(rawType) {
  const t = (rawType || "").toLowerCase();
  if (t.includes("free") || t.includes("open")) {
    return { key: "open", badgeClass: "gwe-badge-open", badgeLabel: "Free" };
  }
  if (t.includes("external")) {
    return { key: "external", badgeClass: "gwe-badge-external", badgeLabel: "Ticket purchase required" };
  }
  return { key: "ticketed", badgeClass: "gwe-badge-ticketed", badgeLabel: "Ticket purchase required" };
}

async function getFreshOpportunity(id) {
  const res = await fetch(`${GHL_BASE}/opportunities/${id}`, { headers: ghlHeaders() });
  if (!res.ok) throw new Error(`Get opportunity ${id} failed: ${res.status}`);
  const data = await res.json();
  return data.opportunity || data;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60, stale-while-revalidate=180");

  try {
    const locationId = process.env.GHL_LOCATION_ID;
    if (!process.env.GHL_API_KEY || !locationId) {
      throw new Error("Missing GHL_API_KEY or GHL_LOCATION_ID environment variable");
    }

    const { pipelineId, stageId } = await getApprovedStageId(locationId);

    const searchUrl = new URL(`${GHL_BASE}/opportunities/search`);
    searchUrl.searchParams.set("location_id", locationId);
    searchUrl.searchParams.set("pipeline_id", pipelineId);
    searchUrl.searchParams.set("pipeline_stage_id", stageId);
    searchUrl.searchParams.set("limit", "100");

    const oppRes = await fetch(searchUrl.toString(), { headers: ghlHeaders() });
    if (!oppRes.ok) throw new Error(`Opportunity search failed: ${oppRes.status}`);
    const oppData = await oppRes.json();
    const candidateIds = (oppData.opportunities || [])
      .filter((o) => o.pipelineStageId === stageId)
      .map((o) => o.id);

    const freshOpps = await Promise.all(candidateIds.map(getFreshOpportunity));

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const events = freshOpps
      .map((o) => {
        const f = {};
        for (const cf of o.customFields || []) {
          const key = ID_TO_KEY[cf.id];
          if (key) f[key] = extractCustomFieldValue(cf);
        }
        return { id: o.id, f };
      })
      .filter((e) => e.f.event_date)
      .filter((e) => {
        const d = new Date(e.f.event_date);
        return !isNaN(d) && d >= today;
      })
      .sort((a, b) => new Date(a.f.event_date) - new Date(b.f.event_date))
      .map((e) => {
        const type = classifyEventType(e.f.event_type);
        const priceRaw = (e.f.ticket_price || "").toString().replace(/^\$/, "").trim();
        const price = type.key === "open" || !priceRaw || priceRaw === "0" ? "FREE" : `$${priceRaw} per person`;
        return {
          id: e.id,
          eventName: e.f.event_name || "GWE Event",
          badgeClass: type.badgeClass,
          badgeLabel: type.badgeLabel,
          eventDate: e.f.event_date,
          startTime: e.f.start_time || "",
          location: e.f.public_location_label || "",
          city: e.f.city || "",
          description: e.f.prep_notes__what_to_bring || "",
          price,
          rsvp: {
            rsvp_event_info: e.f.event_name || "",
            rsvp_event_type: e.f.event_type || "",
            rsvp_event_date: e.f.event_date || "",
            rsvp_start_time: e.f.start_time || "",
            rsvp_end_time: e.f.end_time || "",
            rsvp_real_location__address: e.f.real_location__address || "",
            rsvp_prep_notes: e.f.prep_notes__what_to_bring || "",
            rsvp_ticket_price: e.f.ticket_price || "",
            rsvp_purchase_link: e.f.purchase_link || "",
          },
        };
      });

    res.status(200).json({ events });
  } catch (err) {
    res.status(500).json({ error: "Unable to load events", events: [] });
  }
};
