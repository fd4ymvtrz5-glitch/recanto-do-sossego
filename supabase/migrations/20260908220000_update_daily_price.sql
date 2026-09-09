create or replace function public.create_pending_reservation(
  p_selected_date date,
  p_reservation_option text,
  p_customer_name text,
  p_customer_email text,
  p_customer_phone text,
  p_guest_count smallint,
  p_message text,
  p_idempotency_key text
)
returns public.reservations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total numeric(10, 2);
  v_reservation public.reservations;
begin
  if p_selected_date < current_date then
    raise exception 'selected_date_must_be_future' using errcode = '22023';
  end if;

  select case p_reservation_option
    when 'diaria' then 600
    when 'familia' then 800
    when 'suico' then 800
    else null
  end into v_total;

  if v_total is null then
    raise exception 'invalid_reservation_option' using errcode = '22023';
  end if;

  select * into v_reservation from public.reservations
  where checkout_idempotency_key = p_idempotency_key;
  if found then
    return v_reservation;
  end if;

  if exists (
    select 1 from public.reservations
    where selected_date = p_selected_date
      and status = 'paid'
  ) then
    raise exception 'date_unavailable' using errcode = '23P01';
  end if;

  insert into public.reservations (
    selected_date, reservation_option, total_amount, deposit_amount,
    customer_name, customer_email, customer_phone, guest_count, message,
    checkout_idempotency_key
  ) values (
    p_selected_date, p_reservation_option, v_total, round(v_total * 0.5, 2),
    trim(p_customer_name), lower(trim(p_customer_email)), trim(p_customer_phone),
    p_guest_count, nullif(trim(p_message), ''), p_idempotency_key
  )
  returning * into v_reservation;

  return v_reservation;
end;
$$;
