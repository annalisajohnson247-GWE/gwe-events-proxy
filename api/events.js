// api/events.js
//
// Vercel serverless function. This is the ONLY place your GHL API key lives.
// It never touches the browser. The public page calls this endpoint, and this
// endpoint calls GHL on the server, filters down to Approved events only, and
// strips out anything sensitive before responding.
//
// Required environment variables (set in Vercel project settings, NOT in this file):
//   GHL_API_KEY       -> your Private Integration token (pit-...)
//   GHL_LOCATION_ID    -> oCFoDfYKs6n7V2heFMXW

const GHL_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";
const PIPELINE_NAME = "Event Requests";
const APPROVED_STAGE_NAME = "Approved";

function ghlHeaders() {
  return {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    Version: API_VERSION,
    Accept: "application/json",
  };
}

let stageCache = { pipelineId: null, stageId: null, expires: 0 };
let fieldMapCache = { map: null, expires: 0 };
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
  if (!stage) throw new Error(`Stage "${APPROVED_STAGE_NAME}" not found in pipeline "${PIPELINE_NAME}"`);
  stageCache = { pipelineId: pipeline.id, stageId: stage.id, expires: Date.now() + ONE_HOUR };
  return { pipelineId: pipeline.id, stageId: stage.id };
}

async function getOpportunityFieldMap(locationId) {
  if (fieldMapCache.map && fieldMapCache.expires > Date.now()) {
    return fieldMapCache.map;
  }
  const res = await fetch(`${GHL_BASE}/locations/${locationId}/customFields`, {
    headers: ghlHeaders(),
  });
  if (!res.ok) throw new Error(`Custom fields lookup failed: ${res.status}`);
  const data = await res.json();
  const fields = data.customFields || data.fields || [];
  const map = {};
  for (const f of fields) {
    if (f.fieldKey && f.fieldKey.startsWith("opportunity.")) {
      map[f.id] = f.fieldKey.replace("opportunity.", "");
    }
  }
  fieldMapCache = { map, expires: Date.now() + ONE_HOUR };
  return map;
}

function extractCustomFieldValue(entry) {
  return entry.fieldValueString ?? entry.value ?? entry.fieldValue ?? "";
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

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=120, s-maxage=120, stale-while-revalidate=300");

  try {
    const locationId = process.env.GHL_LOCATION_ID;
    if (!process.env.GHL_API_KEY || !locationId) {
      throw new Error("Missing GHL_API_KEY or GHL_LOCATION_ID environment variable");
    }

    const { pipelineId, stageId } = await getApprovedStageId(locationId);
    const fieldMap = await getOpportunityFieldMap(locationId);

    const searchUrl = new URL(`${GHL_BASE}/opportunities/search`);
    searchUrl.searchParams.set("location_id", locationId);
    searchUrl.searchParams.set("pipeline_id", pipelineId);
    searchUrl.searchParams.set("pipeline_stage_id", stageId);
    searchUrl.searchParams.set("limit", "100");

    const oppRes = await fetch(searchUrl.toString(), { headers: ghlHeaders() });
    if (!oppRes.ok) throw new Error(`Opportunity search failed: ${oppRes.status}`);
    const oppData = await oppRes.json();
    const opportunities = oppData.opportunities || [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const events = opportunities
      .filter((o) => o.pipelineStageId === stageId)
      .map((o) => {
        const f = {};
        for (const cf of o.customFields || []) {
          const key = fieldMap[cf.id];
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
        const price = type.key === "open" || !priceRaw ? "FREE" : `$${priceRaw} per person`;

        return {
          id: e.id,
          eventName: e.f.event_name || "GWE Event",
          badgeClass: type.badgeClass,
          badgeLabel: type.badgeLabel,
          eventDate: e.f.event_date,
          startTime: e.f.start_time || "",
          location: e.f.public_location_label || "",
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
    console.error("GWE events proxy error:", err);
    res.status(500).json({ error: "Unable to load events", events: [] });
  }
};
