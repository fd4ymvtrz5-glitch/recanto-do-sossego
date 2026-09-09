import { corsHeaders, json, options } from "../_shared/cors.ts";
import { adminClient } from "../_shared/supabase.ts";

const OPTIONS = {
  diaria: { title: "Diária na ilha", total: 600, guests: 12 },
  familia: { title: "Chalé Família", total: 800, guests: 6 },
  suico: { title: "Chalé Suíço", total: 800, guests: 4 },
} as const;

type Payload = {
  selectedDate: string;
  reservationOption: keyof typeof OPTIONS;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  guestCount: number;
  message?: string;
};

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function validate(payload: Payload) {
  const option = OPTIONS[payload.reservationOption];
  if (!option || !isIsoDate(payload.selectedDate) || new Date(`${payload.selectedDate}T00:00:00Z`) < new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z")) {
    throw new Error("Data ou opção de reserva inválida");
  }
  if (typeof payload.customerName !== "string" || payload.customerName.trim().length < 2 ||
      typeof payload.customerEmail !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payload.customerEmail) ||
      typeof payload.customerPhone !== "string" || payload.customerPhone.trim().length < 8 ||
      !Number.isInteger(payload.guestCount) || payload.guestCount < 1 || payload.guestCount > option.guests) {
    throw new Error("Confira os dados do hóspede e a quantidade de pessoas");
  }
  return option;
}

Deno.serve(async (request) => {
  const preflight = options(request);
  if (preflight) return preflight;
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const payload = await request.json() as Payload;
    const option = validate(payload);
    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim();
    if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 100) {
      return json({ error: "Idempotency key is required" }, 400);
    }

    const supabase = adminClient();
    const { data: reservation, error: reservationError } = await supabase.rpc("create_pending_reservation", {
      p_selected_date: payload.selectedDate,
      p_reservation_option: payload.reservationOption,
      p_customer_name: payload.customerName,
      p_customer_email: payload.customerEmail,
      p_customer_phone: payload.customerPhone,
      p_guest_count: payload.guestCount,
      p_message: payload.message ?? null,
      p_idempotency_key: idempotencyKey,
    });
    if (reservationError) {
      const status = reservationError.code === "23P01" ? 409 : 400;
      return json({ error: status === 409 ? "Data indisponível" : "Não foi possível criar a reserva" }, status);
    }

    const accessToken = Deno.env.get("MERCADO_PAGO_ACCESS_TOKEN");
    const siteUrl = Deno.env.get("PUBLIC_SITE_URL");
    if (!accessToken || !siteUrl) throw new Error("Mercado Pago or site configuration is missing");
    const preferenceResponse = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ id: payload.reservationOption, title: option.title, quantity: 1, currency_id: "BRL", unit_price: reservation.deposit_amount }],
        payer: { name: payload.customerName, email: payload.customerEmail },
        external_reference: reservation.id,
        back_urls: { success: `${siteUrl}/?reserva=sucesso`, failure: `${siteUrl}/?reserva=falha`, pending: `${siteUrl}/?reserva=pendente` },
        auto_return: "approved",
        notification_url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/mercado-pago-webhook`,
        metadata: { reservation_id: reservation.id },
      }),
    });
    if (!preferenceResponse.ok) {
      const details = await preferenceResponse.text();
      console.error("Mercado Pago preference failed", preferenceResponse.status, details);
      return json({ error: "Não foi possível iniciar o checkout" }, 502);
    }
    const preference = await preferenceResponse.json();
    return json({ checkoutUrl: preference.init_point, reservationId: reservation.id });
  } catch (error) {
    console.error("create-checkout failed", error);
    return json({ error: error instanceof Error ? error.message : "Erro ao iniciar checkout" }, 400);
  }
});
