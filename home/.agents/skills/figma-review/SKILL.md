---
name: figma-review
description: Parse a Figma section/frame into a structured map of user stories, flows, steps, and screens — and optionally mine the user-facing text strings from each screen. Use when the user gives a Figma URL or node ID and asks to "review", "explore", "map out", "understand", "get all subframes of", or "extract wording/copy/text from" a design. Produces a flow-by-flow breakdown with node IDs and, on request, a wording manifest the developer can cross-check against implementation.
---

# Figma Review Skill

Some product designs follow a consistent spatial pattern inside Figma sections. This skill decodes that pattern from raw metadata into a structured breakdown — story → flows → steps → screens — with node IDs the user can act on.

## When to use

Trigger when the user:
- Pastes a Figma URL and asks to explore/review/map it
- Gives a node ID and asks "what's in this?"
- Asks for "all subframes", "all screens", or "all flows" of a design
- Wants a summary before drilling into specific screens for implementation
- Asks to "extract / mine / list / dump the wording / copy / text" from a Figma design (frame *or* single screen — see "Text mining mode" below)

Do NOT trigger for:
- Direct "implement this Figma screen" requests where a single node is already targeted AND the user does not need the wording manifest — go straight to `get_design_context` instead
- Figma Make files

## The spatial convention

Inside such a section, frames are laid out on a grid. The Y-coordinate tells you the **role** of a frame; the X-coordinate tells you its **position within a flow**.

```
┌─ Section (e.g. "Duplicate - Details") ────────────────────────┐
│                                                                │
│  [ Story banner ]                          ← narrow, top       │
│                                                                │
│  [ ══════ Flow 1 header (full-width) ══════ ]                  │
│                                                                │
│  [Step 1 label] [Step 2 label] [Step 3 label]  ← small labels  │
│  [  Screen 1  ] [  Screen 2  ] [  Screen 3  ]  ← ~1440 wide    │
│                                                                │
│  [ ══════ Flow 2 header (full-width) ══════ ]                  │
│                                                                │
│  [Step 1 label] [Step 2 label] [Step 3 label]                  │
│  [  Screen 1  ] [  Screen 2  ] [  Screen 3  ]                  │
└────────────────────────────────────────────────────────────────┘
```

### Role heuristics

| Role | Signal |
|---|---|
| **Story banner** | Narrow-ish frame near top of section (smallest y), often text-only, not full section width |
| **Flow header** | Frame spanning (near) full section width (≫ 1440), at a distinct Y with nothing beside it. These are horizontal separator banners |
| **Step label** | Small frame (width ≈ screen width ~1440, height < 250) at a Y just above a row of screens |
| **Screen** | Large frame, typically 1440×~1000. The actual UI mockups |

**Detection rule**: Group frames by Y-band (frames within ~50px of each other belong to the same row). Within a row, classify by width:
- Width ≈ section width → flow header
- Width ≈ 1440, height < 250 → step label row
- Width ≈ 1440, height > 500 → screen row

## Procedure

### 1. Extract the node ID

From a URL like `figma.com/design/:fileKey/:name?node-id=31247-146526`, the node ID is `31247:146526` (convert the dash to colon). If the URL uses `/branch/:branchKey/`, use `branchKey` as the fileKey.

### 2. Fetch metadata

Call `mcp__figma-desktop__get_metadata` with the node ID. Expect the output to be saved to a persisted-output file if large — that's fine, parse it from there.

Do NOT call `get_design_context` at this stage — that's for drilling into a specific screen later. `get_metadata` is cheaper and gives the tree structure we need.

### 3. Parse the structure

Walk the direct children of the section (or whatever parent node was given). For each child frame, record `id`, `name`, `x`, `y`, `width`, `height`. Then apply the role heuristics above.

If the output was persisted to a file and is too large to read directly, use a Bash one-liner with Python + regex to extract top-level frame attributes. Example pattern:

```python
import json, re
with open('<persisted-path>') as f:
    text = json.load(f)[0]['text']
# Match only depth-1 frames (2 leading spaces in the XML)
pattern = re.compile(r'^  <(frame|instance|group)\s+id="([^"]+)"\s+name="([^"]+)"\s+x="([^"]+)"\s+y="([^"]+)"\s+width="([^"]+)"\s+height="([^"]+)"', re.MULTILINE)
for m in pattern.finditer(text):
    print(m.groups())
```

### 4. Group by flow

Sort direct children by Y. Walk top-to-bottom. Each flow-header frame starts a new flow. Between one flow header and the next (or end-of-section), the rows that follow belong to that flow: the first row under a header is usually step labels, the next is the actual screens. Match step labels to screens by X-coordinate (same column = same step).

### 5. Present the breakdown

Output a short summary + one table per flow. Keep it terse:

```markdown
## Story
**"<story banner text, if discoverable from names>"**
Story frame: `<id>`

## Flow 1 — <flow header name>
Row header: `<id>`

| Step | Label frame | Screen frame | Size |
|---|---|---|---|
| 1. <step name> | `<label-id>` | **`<screen-id>`** <screen name> | WxH |
| ... |
```

End with total counts (frames / instances / text nodes) and offer: *"Want me to pull design context for a specific screen? Just give me the node ID."*

## Output discipline

- **Bold the screen node IDs** — those are what the user will most often act on next.
- Don't try to read screen *contents* from `get_metadata` — the names alone are the summary. If the user wants details of a screen, call `get_design_context` on that specific node.
- If the section only has a single flow, skip the flow-grouping and just list the screens in order.
- If the structure doesn't match the convention (e.g. a loose moodboard, a component page, a Figma Make file), say so plainly instead of forcing the template — report what you see.

## Follow-on actions

After presenting the map, the user will typically want one of:
1. **Drill into a screen** → call `mcp__figma-desktop__get_design_context` on that specific node ID
2. **Implement a flow** → suggest they confirm which flow and which screens, then proceed per `contract-generation-feature` / `building-feature` skills
3. **Compare two flows** (e.g. "Reversed" vs "Cancelled" variants) → fetch design context for the differing screen in each flow, diff the key fields
4. **Extract a wording manifest** → see "Text mining mode" below

## Text mining mode

When the user asks to extract / mine / list / dump the wording, copy, or text strings — or when they're about to implement a feature and want to lock down the canonical strings before coding — produce a **wording manifest** the developer can cross-check against implementation (and that the `product-voice-review` skill will lint against later).

This mode handles two input shapes:

- **Frame mode** (default): the input was a Section / Frame containing flows + screens. Run steps 1–5 first, then mine each screen.
- **Single-screen mode**: the input was a single screen frame with no flow/section structure. Skip frame mapping and go straight to mining the one node.

### Detecting which mode applies

After fetching `get_metadata`, inspect the direct children:

- If you find one or more flow-header rows (frames spanning the section width) → **frame mode**
- If the children are interior UI elements (buttons, inputs, dialogs nested directly under the input node) and there's no flow/step structure → **single-screen mode**
- If ambiguous, ask the user before paying for a frame-wide mining pass

### Procedure

#### A. Frame mode

1. Confirm with the user which screens to mine — `get_design_context` is expensive and a 12-screen frame would be 12 calls. Default to the screens they're about to implement, not all of them.
2. For each chosen screen, call `mcp__figma-desktop__get_design_context` with that screen's node ID.
3. Aggregate the text from each screen into a single manifest (see "Manifest format" below). Group by screen name so the developer can map back.

#### B. Single-screen mode

1. Call `mcp__figma-desktop__get_design_context` once on the input node ID.
2. Produce the manifest for that one screen.

### What to extract

Walk the design context output and pull every user-facing string into the matching bucket. Ignore developer-only text (frame names, comments, section banners that don't appear in the rendered UI).

| Bucket | Looks like | Notes |
|---|---|---|
| **Page / Dialog title** | Largest heading text at the top of the screen / dialog | One per screen |
| **Section labels** | Sub-headings dividing the body (e.g. "Status Transition", "Source Entity Type") | Often Title Case |
| **Field labels** | Labels next to inputs / selects | One per input |
| **Placeholders** | Greyed-out text inside input fields | Critical — these are the most-missed strings |
| **Helper / hint text** | Small text under inputs explaining format or constraints | |
| **Validation states** | Error text shown in error states of the same screen | If the design includes error-state variants, list them; otherwise note "no error state in design" |
| **Button labels** | Primary CTA, secondary CTA, ghost actions | Match casing exactly |
| **Empty state copy** | Title + body text for empty list / no-results states | |
| **Toast / banner copy** | Inline success/error banners or toasts shown in the design | Often shown as a separate variant frame |
| **Confirmation dialog copy** | Title + body of any AlertDialog-style confirmations | |

### Manifest format

Output as a markdown table per screen. Bold the screen name and include the node ID so the developer can re-fetch it.

```markdown
## Wording — **Delete Item dialog** (`123:456`)

| Bucket | String | Notes |
|---|---|---|
| Dialog title | Delete item | |
| Section | Item details | |
| Field label | Reason | required |
| Placeholder | Enter a reason | |
| Validation | Reason is required | from error-state variant |
| Primary button | Delete | destructive |
| Secondary button | Cancel | |
| Confirm dialog title | Delete this item? | from `123:789` |
| Confirm primary | Yes, delete | |
| Confirm secondary | Cancel | |
| Success toast | Item deleted | from toast variant |
```

End the manifest with a one-liner pointing at the linter:

> Run `/product-voice-review` on the implementation diff to verify each string above ships verbatim.

### Output discipline for text mining

- **Do not rewrite or "improve" the Figma copy.** The manifest is the source of truth; the linter compares implementation to it. If a string in Figma violates the catalog, that's a design conversation, not a manifest edit.
- **Surface gaps explicitly.** If a screen has a required input but no error-state variant, write `Validation: <none in design — author per voice-validation-empty>` rather than omitting the row. Silent omissions become silent regressions.
- **Don't try to mine a frame in text-only mode without confirmation.** Mining 12+ screens is a real cost; offer the user a pick-list first.
- **Link node IDs.** Every row that came from a sub-frame variant (error state, confirm dialog, toast) should cite the variant's node ID so the developer can re-check.
