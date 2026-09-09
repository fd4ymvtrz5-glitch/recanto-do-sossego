create extension if not exists pgcrypto;

create type public.reservation_status as enum ('pending', 'paid', 'cancelled', 'expired');

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  selected_date date not null,
  reservation_option text not null check (reservation_option in ('diaria', 'familia', 'suico')),
  total_amount numeric(10, 2) not null check (total_amount > 0),
  deposit_amount numeric(10, 2) not null check (deposit_amount > 0 and deposit_amount <= total_amount),
  customer_name text not null check (char_length(trim(customer_name)) between 2 and 120),
  customer_email text not null check (customer_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  customer_phone text not null check (char_length(trim(customer_phone)) between 8 and 30),
  guest_count smallint not null check (guest_count between 1 and 12),
  message text,
  status public.reservation_status not null default 'pending',
  mercado_pago_payment_id text unique,
  mercado_pago_status text,
  google_event_id text,
  checkout_idempotency_key text not null unique,
  pending_expires_at timestamptz not null default (now() + interval '30 minutes'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index reservations_one_paid_date_idx
  on public.reservations (selected_date)
  where status = 'paid';

create index reservations_public_status_date_idx
  on public.reservations (selected_date, status);

create or replace function public.set_reservations_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger reservations_updated_at
before update on public.reservations
for each row execute function public.set_reservations_updated_at();

alter table public.reservations enable row level security;

revoke insert, update, delete on public.reservations from anon, authenticated;

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
  v_deposit numeric(10, 2);
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

create or replace function public.mark_reservation_paid(
  p_reservation_id uuid,
  p_payment_id text,
  p_payment_status text,
  p_google_event_id text
)
returns public.reservations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation public.reservations;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_reservation_id::text, 0));

  select * into v_reservation from public.reservations
  where id = p_reservation_id for update;
  if not found then
    raise exception 'reservation_not_found' using errcode = 'P0002';
  end if;

  if v_reservation.status = 'paid' then
    if v_reservation.mercado_pago_payment_id = p_payment_id then
      return v_reservation;
    end if;
    raise exception 'reservation_already_paid' using errcode = '23P01';
  end if;

  if exists (
    select 1 from public.reservations
    where selected_date = v_reservation.selected_date
      and status = 'paid'
      and id <> p_reservation_id
  ) then
    raise exception 'date_unavailable' using errcode = '23P01';
  end if;

  update public.reservations
  set status = 'paid',
      mercado_pago_payment_id = p_payment_id,
      mercado_pago_status = p_payment_status,
      google_event_id = p_google_event_id
  where id = p_reservation_id
  returning * into v_reservation;

  return v_reservation;
end;
$$;

revoke execute on function public.create_pending_reservation(date, text, text, text, text, smallint, text, text) from public;
grant execute on function public.create_pending_reservation(date, text, text, text, text, smallint, text, text) to anon, authenticated;
revoke execute on function public.mark_reservation_paid(uuid, text, text, text) from public;
