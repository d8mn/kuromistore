# Kuromi Store — self-contained (no Firebase)

Everything the site needs lives in this one folder:

```
index.js          -> the server (reads/writes JSON, serves images + the site)
package.json       -> dependencies (express, cors)
site.html           -> the store itself (now talks to index.js instead of Firebase)
data/
  products.json
  orders.json
  coupons.json
  feedbacks.json
  notifications.json
  settings.json     -> { storeStatus, shipping, owner }
images/
  uploads/           -> every product photo + customer-uploaded photo lives here as a real file
```

Your existing data (52 products, 97 orders, 121 reviews, etc.) has already been
imported and converted — images were pulled out of the old base64 blobs and
saved as real `.jpg` files in `images/uploads/`, deduplicated by content so the
same photo is never stored twice. Total image footprint went from ~40 MB of
base64 text to ~5 MB of real files.

## 1. Add your logo

The page references `images/x.jpg` for the store logo (header, hero, favicon
fallback). That file was never stored in Firestore — it was just a static file
sitting next to the old `index.html`. Put your logo at:

```
images/x.jpg
```

If it's missing, the page falls back to a placeholder image automatically, so
nothing breaks — it just won't show your logo until you add it.

## 2. Run it locally (to test before you deploy)

You need Node.js installed (v16+).

```bash
npm install
npm start
```

Then open `http://localhost:3000` in your browser. Everything — storefront,
cart, checkout, owner dashboard, image uploads — should work exactly like
before, just without Firebase.

Owner login is whatever was in your old `settings/owner` doc (same
username/password as before — check `data/settings.json` if you forgot it).

## 3. Deploy

This needs a host that can run a **persistent Node.js process** (not a plain
static file host) **and** keep your files on disk between restarts/deploys
(persistent storage, not "ephemeral"). Before you pick a host, confirm both of
those with whatever provider you're using (Spacify or otherwise) — plenty of
cheap Node hosts wipe the filesystem on every redeploy, which would delete
your `data/` and `images/uploads/` folders.

Typical steps on most Node hosts:
1. Upload this whole folder (or push it to the Git repo the host deploys from).
2. Set the start command to `npm start` (or `node index.js`).
3. Make sure the host does **not** overwrite `data/` and `images/` on
   redeploy — those are your database and photo storage now.
4. If the host gives you a specific port via an environment variable, the
   server already reads `process.env.PORT`, so you don't need to change
   anything.

## 4. How "real-time" updates work now

Firestore's `onSnapshot` gave you instant updates for free. Without Firebase,
the page instead **polls** the server quietly in the background:
- Products, coupons, feedbacks, settings: every 6 seconds.
- Orders (and the owner dashboard's "new order" sound): every 4 seconds.

This means a new order can take up to ~4 seconds to show up in the dashboard
instead of being instant — in exchange you get zero database costs and a much
lighter page. If you ever want true instant push updates, that would need a
small addition (WebSockets) on top of this — just ask.

## 5. Backing up your data

Since everything is plain JSON + image files, backing up is just copying the
`data/` and `images/` folders somewhere safe every so often (or putting the
whole project folder under Git / a scheduled zip). There's no database to
export anymore — the files *are* the database.

## 6. Passwords are now hashed

Both the **owner** login and every **customer account** password are now
stored as a salted hash (`scrypt`, built into Node — no extra dependency),
never as plain text, and never sent to the browser:

- The owner password you already had keeps working exactly as before — the
  server quietly re-hashes it the first time it starts up (see the console
  log line "Migrated owner password..." on first run).
- Owner login now goes through `POST /api/login`, which only ever returns
  `{ ok: true/false }` — the password itself never leaves the server.
- Customer accounts work the same way through `POST /api/users/login` and
  `POST /api/users/signup`, returning a random session token (not the
  password) that the browser then sends back as
  `Authorization: Bearer <token>` on anything that needs to know who's
  signed in (like the "Me" page or updating a profile photo).

One trade-off: sessions are kept in memory, not saved to disk, so everyone
gets signed out if the server restarts (they just sign back in — their
account and data are untouched).

## 7. Customer accounts (new)

The whole storefront now sits behind a mandatory sign-in/sign-up wall (your
owner dashboard login is separate and unaffected). What this unlocked:

- **Sign up** asks for a username, password, email and mobile number, same
  as you described. **Sign in** just needs username + password.
- **Notify Me** no longer asks for an email — it already knows the signed-in
  account's email and uses it automatically.
- **Checkout** pre-fills WhatsApp number and email from the account (still
  editable, in case someone wants to use a different number for one order).
- Every new order is tagged with the account's id behind the scenes, which
  is what powers the new **Me** page.
- **Me** page (new nav tab, after "Rate us!"): shows the account's avatar
  (tap the camera icon to change it — uploads a real file, same as product
  photos), username, email, phone, a running total of orders placed and
  money spent, and the full order history with live status. There's also a
  **Log Out** button there.
- **Users** tab in the owner dashboard (new, next to Priority): lists every
  account with its status. You can **Suspend** one for N days, **Ban** it
  outright, or **Delete** it permanently, and reverse suspend/ban anytime.

**Who can do what (accounts):** the Users tab and its Suspend / Ban / Delete
buttons are now enforced by the server, not just hidden. They need the owner's
signed-in session, so a customer (or anyone without a login) gets a refusal if
they try to call those addresses directly. Passwords and hashes are never
returned. The owner's own account is listed (with an "Owner" badge) but can
never be suspended, banned or deleted.

Still open, as in the original Firebase version: reading the orders list and
changing products, categories, coupons and settings are not yet restricted by
the server (the dashboard just doesn't show those buttons to customers). That
matters most for orders, because they contain customer names, phone numbers and
addresses. If you want those locked to the owner too, say so; it works the same
way as the Users tab now does.

## 8. One login for everyone (owner included)

The separate "Owner" button and its own login popup are gone. There's now
just one sign-in screen (the account wall everyone sees on entry), and the
server tells the page whether that account is the owner or a regular
customer via a `role` field (`"owner"` or `"client"`):

- Your existing owner username/password were automatically migrated into
  the same accounts system as a `role: "owner"` entry — same credentials,
  nothing to redo.
- Sign in with that account and the **Dashboard** button simply appears in
  the header, same as before.
- Every new signup is a `role: "client"` account and never sees that button.
- The owner's own account is hidden from the dashboard's **Users** tab (so
  you can't accidentally suspend/ban/delete yourself).

## 9. Sessions expire after 15 days

Signing in (or signing up) keeps you logged in for **15 days** — the app
checks this on the server, not just in the browser, so it can't be bypassed.
After 15 days, the next page load quietly shows the sign-in wall again; your
account and all its data are untouched, you just need to sign back in. This
applies to customer accounts and the owner account the same way.

## 10. Top 3 Customers (home page)

A "Top customers" section on the home page ranks the 3 accounts with the most
**completed** orders. An order only counts once you press **Mark as Done** in
the dashboard; pending orders don't count. It is calculated on the server, and
only the display name, avatar and order count are sent to the page (never
emails or phone numbers).

It only counts orders that were placed while signed in to an account. Orders
imported from the old Firebase site have no account attached, so they are not
counted, and the section starts empty until customers order with accounts.
Your own owner account counts too, so you can test it yourself: place an
order, mark it done, and your account appears.

## 11. Less lag / flashing

Two things were causing the page to visibly "blink": re-rendering the
product grid on every single background poll cycle even when nothing
changed, and that re-render re-triggering the fade-in animation on cards
that were already on screen. Both are fixed — product cards no longer
re-animate on every refresh, and the search box now waits a moment after you
stop typing before re-filtering instead of rebuilding the grid on every
keystroke.

## 12. Add to Home Screen (standalone app, no browser bar)

The site now has a web app manifest (`manifest.json`) and a small service
worker (`sw.js`), which together are what let a phone's "Add to Home Screen"
open the site as its own app — no address bar, no browser tabs — instead of
just a bookmark. The service worker deliberately caches nothing: every request goes straight
to the network, so you always see what the server is serving right now (an
earlier version cached the page shell, which could show a stale copy of the
site; the new version also deletes that old cache automatically).

For the best-looking home screen icon, replace `images/x.jpg` with a square
image sized at least 512×512 — the manifest currently points both the
192×192 and 512×512 icon slots at that same file and lets the browser scale
it, which works but isn't as crisp as a properly-sized image.

## 13. Categories (new)

The Store tab is now organised by category instead of one long list.

**Owner dashboard -> Categories tab**
- **Create:** type a name, tick any products from the checklist (as many as
  you like), Save.
- **Edit:** press Edit on a category to rename it and tick/untick products;
  Save applies both the name and the membership changes.
- **Delete:** removes the category; its products simply become
  "Uncategorized" (they are not deleted).
- The **Add / Edit Product** form has a **Category** dropdown too, so you can
  also assign a product while you create it. Both places edit the same
  thing (the product's `categoryId`), so they always agree. A product belongs
  to one category at a time.

**Store tab**
- Each category shows its name and its first 3 products, then a
  **More products (N)** button that expands the rest in place (press again
  for **Show less**). Products with no category appear under "Uncategorized".
- Category order is random, but it stays steady while you browse; it
  reshuffles the next time the Store tab is opened.
- Using search, sorting or the category filter switches to a plain filtered
  grid (so results are never hidden inside collapsed sections); clear them to
  return to the grouped view.

Your 11 products that already had the old free-text category (Art, Handmade,
Stock, ...) were converted into real categories automatically the first time
the server starts. One of them is a typo ("Custome prints" next to "Customer
prints"); just move those products into one category in the Categories tab
and delete the extra one.

## 14. Background image

Drop your image at `images/bg.jpg`. It is shown fixed behind the whole site
under a soft tint (so text stays readable in both dark and light mode). If the
file is missing the page just uses the plain background colour.

## 15. Language (English / Arabic) and Dark / Light mode

Two small buttons in the header (and on the sign-in screen) switch language
(AR / EN) and theme (sun / moon). Both choices are remembered per browser.

- Arabic switches the whole page to right-to-left. Only the site's own
  interface text is translated (menus, buttons, labels, messages,
  dashboard...). Product names, descriptions, category names, customer names
  and addresses are your data and are shown exactly as entered.
- Translation works by swapping known English phrases for Arabic while Arabic
  is on, including things that appear later (product cards, pop-up messages,
  dashboard lists). A phrase that has no Arabic entry simply stays in
  English instead of breaking anything. New interface text you add later
  needs an entry in the `AR_EXACT` list near the bottom of `site.html`.
- Light mode re-colours the whole site, including the dashboard charts.

## 16. Housekeeping

- All emoji were removed from the code and interface.
- The English wording was tidied (e.g. "Message us on WhatsApp",
  "Total (incl. shipping)").
- Failed requests now show a clean message instead of raw JSON.
- The service worker no longer caches pages, so stale copies can't be shown.

## 17. Troubleshooting: "ERR_CONNECTION_REFUSED" on localhost:3000

If the browser console is full of lines like
`GET http://localhost:3000/api/... net::ERR_CONNECTION_REFUSED`, look at the
address bar. Every request the page makes goes to **the same address the page
was opened from**, so those errors mean the page itself was opened at
`localhost:3000`.

`localhost` always means "the computer you are sitting at". On your own
computer it only works while you have started the server yourself
(`npm start`). Once the site is hosted, the server runs on your host's
machine, not yours, so opening `localhost:3000` finds nothing and every request
is refused. (The startup message in older versions said "running on
localhost:3000", which is true *inside* the host but easy to misread as the
address to visit.)

What to do:
1. Open the site from the **public address your host gives you** (its own
   domain or subdomain), not from `localhost`.
2. If your host asks for a start command, use `npm start` (or `node index.js`).
   The app reads the port from the host's `PORT` / `SERVER_PORT` / `APP_PORT`
   setting automatically and listens on all network interfaces.
3. If an old copy of the page keeps appearing at `localhost:3000` even though
   nothing is running, that is a leftover from an earlier local test. In
   Chrome press F12, open **Application -> Service Workers -> Unregister**,
   then **Storage -> Clear site data**, and reload. (The current service worker
   no longer caches pages, so this won't happen again after the update.)

The page now helps with this itself: when the server can't be reached it shows
a red banner naming the address it is trying, with a Retry button, and it stops
retrying every few seconds (it backs off up to 30 s and resumes on its own as
soon as the server answers). A saved login is no longer thrown away just
because the server was briefly unreachable.

## 18. "My Orders" tab removed

Customers now see their orders only in the **Me** tab (order history, total
spent, live status). The separate "My Orders" tab and page were removed, and
the "you already have a pending order" message now sends people to **Me**.

One thing to know: Me finds a customer's orders through the account they were
placed with. Orders placed before accounts existed (the ones imported from
Firebase) aren't linked to any account, so they don't appear in anyone's Me
page. You still see all of them in the owner dashboard.

## 19. Multiple people writing at once

The server queues writes per-file, so two orders landing at the same instant
can't corrupt `orders.json`. This is fine for a store doing normal order
volumes. It is **not** built for heavy concurrent traffic (hundreds of
simultaneous writes) — if the store ever gets to that scale, that's the point
to move to a real database.
