# Gmail Filter Builder

A simple, static web app for building Gmail filters — no server, no sign-in, nothing leaves your browser.

Build filters from match conditions (From, To, Subject, Has the words, Doesn't have, Has attachment, Size) and actions (Skip the Inbox, Mark as read, Star it, Apply a label, Categorize as, Forward it to, Delete it, Never send to Spam, Always / Never mark as important), drag cards to reorder them, then download the set as Gmail's own import file.

Live site: https://enonymous1.github.io/gmail-filter-builder/

## Use it

1. Open the site.
2. Fill in the builder, or tap a template (Newsletters, Receipts & invoices, Social notifications, Big attachments, VIP sender).
3. Click **Add filter**. Drag filter cards to reorder, or edit, duplicate, and delete them.
4. Click **Download XML** to save `gmail-filters.xml`.

## Import into Gmail

1. In Gmail: Settings → See all settings → **Filters and Blocked Addresses** → **Import filters**.
2. Pick the downloaded `gmail-filters.xml`.
3. Gmail creates new filters from it — it does not overwrite your existing ones.

Try it with one filter first before importing a large set. Gmail has a 1,000-filter limit.

You can also import an existing Gmail filter export back into the builder: drag a `mailFilters.xml` file onto the import panel, or use the file picker / paste box there, and edit those filters before exporting again.

## Format

The download uses Gmail's own filter export format: an Atom feed (`Mail Filters`, `tag:mail.google.com,2008:filter`) with one `<entry>` per filter and `apps:property` entries for each criterion and action — for example `shouldArchive` for Skip the Inbox, and `size` + `sizeOperator` + `sizeUnit` for a size condition. That is the format Gmail's **Import filters** accepts.

## Privacy

Everything runs locally in your browser. No account, no server, no data sent anywhere. Filters are kept only in the page while you use it.

## Development

There is no build step. The whole app is `index.html` — open it directly, or serve the folder with any static server. To publish it, push this repo to GitHub and enable Pages (Settings → Pages → Deploy from a branch, `main` / `/ (root)`).
