# Frontend Development Guidelines

> Executable conventions for VALE's static HTML/CSS/JavaScript frontend and Node.js data tooling.

---

## Overview

VALE is a static multi-page site with plain browser JavaScript, one shared CSS file, generated JSON/HTML, CommonJS build scripts, and Node/Edge tests. These guides document the repository's current patterns rather than a framework architecture it does not use.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Hand-edited sources, generators, and generated outputs | Active |
| [Component Guidelines](./component-guidelines.md) | Native DOM/template/class conventions and shared styling | Active |
| [Hook Guidelines](./hook-guidelines.md) | Framework-free lifecycle and data-fetching patterns | Active |
| [State Management](./state-management.md) | Page, browser-storage, URL, and repository JSON state | Active |
| [Quality Guidelines](./quality-guidelines.md) | Actual test/build/review and repository-safety gates | Active |
| [Type Safety](./type-safety.md) | Plain-JavaScript runtime validation contracts | Active |
| [Pack Ingestion](../PACK_INGESTION.md) | Resource-pack upload, registry, list, and extraction contracts | Active |

---

## Pre-Development Checklist

- Always read [Directory Structure](./directory-structure.md) and [Quality Guidelines](./quality-guidelines.md).
- For browser UI work, also read [Component Guidelines](./component-guidelines.md), [State Management](./state-management.md), and [Hook Guidelines](./hook-guidelines.md).
- For JavaScript/JSON contract work, read [Type Safety](./type-safety.md).
- For scanning, uploading, extracting, replacing, or indexing resource packs, read [Pack Ingestion](../PACK_INGESTION.md) and [Pack Content Identity](../PACK_CONTENT_IDENTITY.md).
- For SBI work, also follow the versioning and regression rules in the root `AGENTS.md`.

## Maintenance Rule

Update these files when a task establishes a reusable implementation contract or exposes a recurring failure mode. Keep one-off execution evidence in the task or operational report instead.

---

**Language**: All documentation should be written in **English**.
