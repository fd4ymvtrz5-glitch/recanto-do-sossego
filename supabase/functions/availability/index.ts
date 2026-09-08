import { corsHeaders, json, options } from "../_shared/cors.ts";
import { adminClient } from "../_shared/supabase.ts";

Deno.serve(async (request) => {
  const preflight = options(request);
  if (preflight) return preflight;
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const date = new URL(request.url).searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Invalid date" }, 400);
  const { data, error } = await adminClient().from("reservations").select("selected_date,status,pending_expires_at").eq("selected_date", date).in("status", ["pending", "paid"]);
  if (error) return json({ error: "Availability is temporarily unavailable" }, 503);
  const active = data.some((reservation) => reservation.status === "paid" ||
    (reservation.status === "pending" && reservation.pending_expires_at > new Date().toISOString()));
  return new Response(JSON.stringify({ available: !active, date }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
