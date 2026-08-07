---
name: call-graph
description: Format call graphs, execution flows, and architecture traces. Use when project overviews, architecture summaries, or code explanations show component call hierarchy.
---

## Call Graph Output

When showing call graphs, execution flows, or architecture traces, use this format:

Production:

```ts
HTTP handlers
  → ComponentA
    → ComponentA.layerX
      → ComponentB
        → ComponentC
```

Tests:

```ts
HTTP handlers
  → ComponentA
    → componentMemoryLayer
      → ComponentA.layer
        → ComponentB.layerMemory
```

- Plain text only, no rendered diagrams
- Indented `→` arrows for hierarchy
- `ts` code block
- Production and Tests as separate sections when they differ
- Include call graphs in project overviews, architecture summaries, and code explanations
