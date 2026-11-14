# Job Tracker

Track job applications on your own computer. Nothing leaves your machine.

## Run

    python -m pip install -r requirements.txt
    python app.py

Or double-click run.bat. Your browser opens at http://127.0.0.1:5001
(SQL Explorer uses 5000, so both can run at the same time).

## Your data

On first run, choose where to save your data. By default, Job Tracker recommends
`~/JobTrackerData`, outside the project folder. The database, contacts, notes,
and PDF attachments stay there on your computer; they are not saved to GitHub.
The selected folder path is remembered in `~/.job-tracker/config.json`.

To back up, copy the selected data folder. To move to another computer, copy
that folder and select it during setup on the other computer. A missing saved
folder is reported at startup, with the recommended location shown.

The app does not import an older `data` folder from inside the project. That
folder is ignored by Git as a safeguard for local data.

## Using it

- The table is the home screen. Change a status right in the table.
- The chips above the table filter by status; every column also has a funnel filter.
- Click an ID (like #014) to open the pop-up: Job info, Job description,
  Contacts, Notes, PDF attachments. Changes save as you type. Esc closes it.
- PDF attachments: one resume and one cover letter per application.
  Drop a PDF on a slot, or use Choose file. Uploading again replaces it.
- Follow-up dates show "Today" in yellow and "Overdue" in red, unless the
  application is Accepted, Rejected, Ghosted or Withdrawn.
- Graph works like SQL Explorer's and follows the table's filters and search.
  Saved charts are stored in this browser.

## Settings (top of app.py)

- `STATUSES`: the status list, in order
- `CLOSED_STATUSES`: statuses that don't get follow-up reminders
- `PORT`, `MAX_PDF_MB`

## Files

    app.py                 Python: saves applications, contacts and PDFs
    templates/index.html   Page structure
    static/style.css       Shared look (same as SQL Explorer)
    static/tracker.css     Table, status colours, pop-ups
    static/app.js          Table, filters, search, pop-up, contacts, PDFs
    static/charts.js       Graph section (shared with SQL Explorer)
    static/charts.css      Graph styles and the drag handle
    static/layout.js       Drag handle under the Graph
    static/chart.umd.min.js  Chart.js 4.4.1, kept locally so it works offline
