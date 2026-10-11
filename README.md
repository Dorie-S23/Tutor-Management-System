# Tutor Management System

![tests](https://sdp.ms.wits.ac.za/the-devden/Tutor-Management-System/actions/workflows/test.yml/badge.svg?branch=main)

| Coverage Target | Badge                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Server API      | ![server api coverage](https://sdp.ms.wits.ac.za/the-devden/Tutor-Management-System/raw/branch/badges/server-api.svg?v=2) |
| Client UI       | ![client ui coverage](https://sdp.ms.wits.ac.za/the-devden/Tutor-Management-System/raw/branch/badges/client-ui.svg?v=2)   |
| Overall         | ![coverage](https://sdp.ms.wits.ac.za/the-devden/Tutor-Management-System/raw/branch/badges/coverage.svg?v=2)              |

A web app for organising tutor allocations to courses — tracking which courses need tutors, matching tutors against courses, and flagging clashes (marks, timetable, hours remaining).

Link: https://tutorx.devden.workers.dev/

### Documentation

We used Docusaurus to document our development.
Link: https://tutorx-documentation.devden.workers.dev/

### Public API

A read-only, no-authentication course catalogue is published at https://tutorx.devden.workers.dev/api/v1 — endpoints, filters, and examples are on the [Public API](https://tutorx-documentation.devden.workers.dev/docs/public-api) page of our documentation site.

### Issue & Task Tracking

Tasks and bugs are tracked on the team's [Jira board](https://thedevden.atlassian.net/jira/core/projects/TMS/board) (project `TMS`).

### AI Usage

This project used AI coding assistants (Qoder, Claude Code) under the COMS3011A AI attribution policy — tool, model, and purpose are listed on the [AI Usage](https://tutorx-documentation.devden.workers.dev/docs/ai-usage) page of our documentation site.

## Running Locally

```bash
npm install
cp .env.example .env   # then fill in your Supabase URL + anon key
npm start
```

The server runs at `http://localhost:3000` by default (override with `PORT` in `.env`). Run the test suite with `npm test`.

### Documentation Site

Project documentation is written separately using Docusaurus, in [`my-docs/`](my-docs/):

```bash
cd my-docs
npm install
npm start
```
