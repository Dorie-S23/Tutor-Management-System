# Tutor Management System

A web app for organising tutor allocations to courses — tracking which courses need tutors, matching tutors against courses, and flagging clashes (marks, timetable, hours remaining).

Link: https://tutorx.devden.workers.dev/

### Documentation
- **[Docusaurus](https://docusaurus.io/)** — separate static site generator (React-based) for project documentation, self-contained in `my-docs/` with its own `package.json`.

## Running Locally

```bash
npm install
# create a .env file with SUPABASE_URL and SUPABASE_KEY
npm start
```

The server runs at `http://localhost:3000` by default (override with `PORT` in `.env`).

## Documentation Site

Project documentation is written separately using Docusaurus, in [`my-docs/`](my-docs/):

```bash
cd my-docs
npm install
npm start
```
