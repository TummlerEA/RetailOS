/*
 * Which Supabase project this app talks to.
 *
 * Both values here are public by design. They ship inside the page's
 * JavaScript, so anyone who opens the app can read them — that is expected.
 * What keeps the data private is elsewhere:
 *
 *   - row-level security on both tables, so the key alone reads nothing
 *     until somebody signs in;
 *   - self-signup turned off, so an account cannot simply be created.
 *
 * The secret key (older projects call it service_role) bypasses row-level
 * security completely and must never appear in this file or any other file
 * the browser can see.
 *
 * Point this at a different project and the app follows; leave the values
 * empty and it works offline, on one device, with the Sync section in
 * Settings saying so.
 */
window.RETAILOS_CONFIG = {
  supabaseUrl: "https://pkothyzdactdfxfubnkk.supabase.co",
  supabasePublishableKey: "sb_publishable_Enti92Cn6BWPfJLUA7_ciw_g2ZsH-JG"
};
