# Setting up Supabase

Twenty minutes, once. You need a Supabase account and nothing else installed.

## 1. Create the project

**supabase.com/dashboard** → **New project**.

| Field | What to put |
| --- | --- |
| Organisation | The one created with your account |
| Name | Anything you like — `retail-ops`, `retailos`. It is only a label in the dashboard; the project is identified by the URL Supabase gives it |
| Database password | Press **Generate**, then **save it in your password manager** |
| Region | **London (eu-west-2)** — nearest to the data and the people |
| Plan | Free |

**Save the password now.** Supabase shows it once. You do not need it for the
app, but you cannot connect Power BI without it, and resetting it later means
re-entering it everywhere.

Provisioning takes a couple of minutes.

## 2. Create the tables

Left sidebar → **SQL Editor** → **New query**. Paste the whole of
[`schema.sql`](schema.sql) in and press **Run**.

You should see `Success. No rows returned`. It is safe to run again if you
are not sure it worked.

Check it: left sidebar → **Table Editor**. You should see `stores` and
`targets`, both empty, each marked **RLS enabled**.

## 3. Stop strangers signing themselves up

Left sidebar → **Authentication** → **Sign In / Providers** → **Email**.
Turn **off** "Allow new users to sign up".

This is a five-person internal tool. Without this, anybody who finds the app
can create themselves an account and read every target you have.

## 4. Add the people who will use it

**Authentication** → **Users** → **Add user** → **Create new user**.

Enter their email and a password, and tick **Auto Confirm User** so they do
not have to click a link in an email. Repeat for each person. Send them the
password by whatever channel you would normally send a password, and have
them change it on first sign-in.

**Generate each password in a password manager** — twenty or more random
characters. Supabase can check new passwords against HaveIBeenPwned, but
only on the Pro plan, so on Free nothing will stop someone reusing the
password they use everywhere else. A generated password makes the check
moot: it was never in a breach to begin with. Reuse is the real risk here,
and saying so when you hand the account over is the whole mitigation.

Because step 3 turned self-signup off, this page is the only way an account
comes into existence. That is what is protecting the data, so keep the list
short and remove people here when they leave.

## 5. Collect the two things the app needs

Top of the dashboard → **Connect**, or **Project Settings** → **API**.

- **Project URL** — `https://<something>.supabase.co`
- **Publishable key** (older projects call it the **anon** key) — a long
  string starting `sb_publishable_` or `eyJ…`

Both of these are **meant to be public**. They will sit in the app's
JavaScript where anyone can read them. What keeps the data private is the
row-level security from step 2 plus step 3, not the key.

The **secret** key (older name: **service_role**) bypasses row-level
security entirely. It must never go anywhere near the browser app. You do
not need it at all.

## 6. Connect Power BI

Top of the dashboard → **Connect** → the **Session pooler** tab. It gives
you a host, port, database and user. In Power BI Desktop:

**Get data** → **PostgreSQL database** → Server `<host>:<port>`, Database
`postgres` → **Database** authentication, with the user from that tab and
the password from step 1 → set encryption/SSL on when prompted.

Then pick the **`targets_report`** view rather than the raw tables. It has
the store name and channel already joined on, the month as a real date, and
the two consistency checks worked out.

**If it will not connect, you are probably on the Direct connection string.**
Supabase's direct connections are IPv6-only on the free plan and most
corporate networks are IPv4. The Session pooler tab is the IPv4 one. That is
the single most common reason this step fails.

## What you have now

An empty Postgres database with the right shape, locked to the handful of
people you named, and readable by Power BI. Nothing writes to it yet — the
app is still saving to the browser. Wiring the app up to this is the next
piece of work.
