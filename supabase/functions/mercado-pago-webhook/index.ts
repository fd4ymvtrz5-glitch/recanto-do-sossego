import { json } from "../_shared/cors.ts";
import { adminClient } from "../_shared/supabase.ts";

type Payment = { id: string; status: string; transaction_amount: number; external_reference?: string; metadata?: { reservation_id?: string } };

async function getPayment(paymentId: string): Promise<Payment> {
  const token = Deno.env.get("MERCADO_PAGO_ACCESS_TOKEN");
  if (!token) throw new Error("Mercado Pago access token is missing");
  const response = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Mercado Pago payment lookup failed: ${response.status}`);
  return await response.json() as Payment;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const notification = await request.json() as { type?: string; data?: { id?: string } };
    if (notification.type !== "payment" || !notification.data?.id) return json({ received: true });
    const payment = await getPayment(notification.data.id);
    if (payment.status !== "approved") return json({ received: true });
    const reservationId = payment.external_reference ?? payment.metadata?.reservation_id;
    if (!reservationId || !/^[0-9a-f-]{36}$/i.test(reservationId)) throw new Error("Payment has no valid reservation reference");

    const supabase = adminClient();
    const { data: reservation, error: lookupError } = await supabase.from("reservations")
      .select("id,status,mercado_pago_payment_id,deposit_amount,selected_date,reservation_option,customer_name,customer_email")
      .eq("id", reservationId).single();
    if (lookupError || !reservation) throw new Error("Reservation not found");
    if (reservation.status === "paid" && reservation.mercado_pago_payment_id === payment.id) return json({ received: true });
    if (Number(payment.transaction_amount) !== Number(reservation.deposit_amount)) throw new Error("Payment amount does not match reservation deposit");

    const googleEventId = await createGoogleCalendarEvent(reservation, payment.id);
    const { error } = await supabase.rpc("mark_reservation_paid", {
      p_reservation_id: reservation.id, p_payment_id: payment.id,
      p_payment_status: payment.status, p_google_event_id: googleEventId,
    });
    if (error) {
      if (error.code === "23P01") return json({ error: "Date was already reserved" }, 409);
      throw error;
    }
    return json({ received: true });
  } catch (error) {
    console.error("mercado-pago-webhook failed", error);
    return json({ error: "Webhook could not be processed" }, 500);
  }
});

type CalendarReservation = { id: string; selected_date: string; reservation_option: string; customer_name: string; customer_email: string };

async function createGoogleCalendarEvent(reservation: CalendarReservation, paymentId: string): Promise<string> {
  const clientEmail = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY");
  const calendarId = Deno.env.get("GOOGLE_CALENDAR_ID");
  if (!clientEmail || !privateKey || !calendarId) throw new Error("Google Calendar secrets are missing");
  const token = await googleAccessToken(clientEmail, privateKey);
  const start = reservation.reservation_option === "diaria" ? "09:00:00-03:00" : "18:00:00-03:00";
  const endDate = reservation.reservation_option === "diaria" ? reservation.selected_date : addOneDay(reservation.selected_date);
  const eventId = reservation.id.replaceAll("-", "").slice(0, 64);
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      id: eventId,
      summary: `Reserva — ${reservation.reservation_option} — ${reservation.customer_name}`,
      description: `Reserva ${reservation.id}. Pagamento Mercado Pago ${paymentId}.`,
      start: { dateTime: `${reservation.selected_date}T${start}`, timeZone: "America/Sao_Paulo" },
      end: { dateTime: `${endDate}T17:00:00-03:00`, timeZone: "America/Sao_Paulo" },
      attendees: [{ email: reservation.customer_email }],
    }),
  });
  if (response.status === 409) return eventId;
  if (!response.ok) throw new Error(`Google Calendar event creation failed: ${response.status}`);
  const event = await response.json() as { id?: string };
  if (!event.id) throw new Error("Google Calendar returned no event id");
  return event.id;
}

function addOneDay(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

async function googleAccessToken(email: string, rawKey: string): Promise<string> {
  const key = await importPrivateKey(rawKey);
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(JSON.stringify({ iss: email, scope: "https://www.googleapis.com/auth/calendar", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claim}`));
  const assertion = `${header}.${claim}.${base64url(signature)}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!response.ok) throw new Error(`Google token request failed: ${response.status}`);
  const data = await response.json() as { access_token?: string };
  if (!data.access_token) throw new Error("Google token response has no access token");
  return data.access_token;
}

async function importPrivateKey(raw: string): Promise<CryptoKey> {
  const pem = raw.replace(/\\n/g, "\n").replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const bytes = Uint8Array.from(atob(pem), (char) => char.charCodeAt(0));
  return await crypto.subtle.importKey("pkcs8", bytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

function base64url(input: string | ArrayBuffer) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
