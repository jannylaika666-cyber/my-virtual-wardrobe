@AGENTS.md

# CLAUDE CODE GUIDELINES & PROJECT MEMORY

## 1. UI/UX Design System (For UI Unity)
To keep the entire website visually unified, ALWAYS follow these styling rules:
- **Design Aesthetic:** Minimalist, clean, high-contrast, modern aesthetic.
- **Color Palette:**
  - Background: Pure White (`#FFFFFF`) or Dark Canvas (`#09090B`) depending on theme.
  - Primary Accent: Solid Black (`#000000`) for primary buttons and active states.
  - Borders/Dividers: Light Grey (`border-zinc-200` or `border-zinc-800`).
  - Text: High contrast (`text-zinc-900` for main, `text-zinc-500` for muted).
- **Typography:** Sans-serif, clean hierarchy, precise tracking (`tracking-tight`).
- **Components & Interactivity:**
  - Roundness: Subtle rounded corners (`rounded-lg` or `rounded-xl`).
  - Buttons: Black solid fill for primary actions, ghost/outline for secondary.
  - Icons: Use `lucide-react` icons exclusively. Keep icon stroke thin (1.5px - 2px).
- **Responsive Standard:**
  - Desktop: Hover effects enabled (e.g., show Edit/Delete buttons on hover).
  - Mobile/Touch: No hover states needed. Show critical action buttons (like Delete) directly. Tap cards/boxes directly to open/edit.

---

## 2. Tech Stack & Architecture
- **Framework:** Next.js (App Router)
- **Styling:** Tailwind CSS
- **Database & Storage:** Supabase (PostgreSQL & Supabase Storage)
- **Icons:** Lucide React

---

## 3. Development Workflow & Rules
1. **Prevent Event Propagation:** Always use `e.stopPropagation()` on nested clickable buttons (e.g., Delete/Edit buttons inside a card) to prevent triggering parent card actions.
2. **Safe Deletion:** Always show a confirmation dialog before performing permanent delete operations.
3. **Database Consistency:** When adding new fields to UI forms, always ensure the corresponding column exists in Supabase.

---

## 4. Progress Log & Completed Features (Project Memory)
*Claude: Update this section whenever a new feature is fully implemented and tested.*

- [x] Initial project setup with Next.js & Tailwind CSS.
- [x] Integrated Supabase Database & Storage for wardrobe items.
- [x] Implemented Filter by Color feature (with checkboxes).
- [x] Created Edit Item functionality with pre-filled Modal.
- [x] Implemented Trip Folders and Look Archiver.
- [x] Updated Look cards: Tap card to edit on mobile, hover for desktop; display black Delete button with `e.stopPropagation()`.
