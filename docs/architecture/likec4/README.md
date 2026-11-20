# MeatGeek V2 architecture model (LikeC4)

This directory holds the [LikeC4](https://likec4.dev) model of MeatGeek V2. It is
the source of truth for the architecture diagrams: change the model here, not a
hand-drawn picture.

The Mermaid diagrams in [`../diagrams.md`](../diagrams.md), which render inline
on GitHub, are generated from this model and never edited by hand. See
[Regenerate `diagrams.md`](#regenerate-diagramsmd).

| File            | Holds                                                                    |
| --------------- | ------------------------------------------------------------------------ |
| `spec.c4`       | Element kinds, tags, relationship kinds, deployment node kinds           |
| `model.c4`      | Elements and relationships: actors, the system, its parts, external deps |
| `views.c4`      | Static views, flows (dynamic views) and the shared view styles           |
| `deployment.c4` | Where things run (dev environment) and the deployment view               |

The toolchain is pinned: `likec4` (`1.61.0`), and `mermaid` (`11.17.2`) with
`jsdom` for the Mermaid parse check, are exact `devDependencies` in this
directory's own `package.json` and `package-lock.json`. This package is not one
of the root npm workspaces, so it never touches the app monorepo's lockfile or Nx
project graph.

## Preview locally

From the repository root:

```sh
npm ci --prefix docs/architecture/likec4
npm --prefix docs/architecture/likec4 start
```

`start` runs `likec4 start .`, a local preview server that reloads as you edit
the `.c4` files. Open the URL it prints.

To build the static site instead (written to `dist/`, which is git-ignored):

```sh
npm --prefix docs/architecture/likec4 run build
```

The [LikeC4 VS Code extension](https://marketplace.visualstudio.com/items?itemName=likec4.likec4-vscode)
gives completion, go-to-definition and inline errors while editing.

## Validate

```sh
npm --prefix docs/architecture/likec4 run check
```

or, from inside this directory, `npm run check`. It runs, in order, and stops at
the first that exits `1`:

1. `likec4 validate .`, which fails on any model error (for example a
   relationship to an element that does not exist);
2. `scripts/check-honesty.mjs`, which enforces the honesty convention below and
   names every offender;
3. `scripts/check-mermaid.mjs`, which parses every `mermaid` code block in
   `../diagrams.md` with the pinned Mermaid 11 and names each block that fails;
4. `scripts/gen-diagrams.mjs --check`, which regenerates `diagrams.md` to a temp
   file and fails when it differs byte-for-byte from the committed file, naming
   `docs/architecture/diagrams.md`, the first differing line and the regenerate
   command.

Run it before you push; CI's `architecture-model` job runs the same script.
Further checks will be appended to `check` over time, so always call the script
rather than `likec4 validate` directly.

`npm run check:selftest` proves the honesty check itself: it runs the checker on
each fixture under `scripts/fixtures/` (stored as `*.c4.fixture` so they never
join the real model) and passes only if every violating fixture is rejected and
the clean one is accepted.

## Regenerate `diagrams.md`

After any change to a `.c4` file, regenerate and commit `../diagrams.md` in the
same pull request:

```sh
npm --prefix docs/architecture/likec4 run gen:diagrams
```

`scripts/gen-diagrams.mjs` runs `likec4 gen mmd` and `likec4 export json` into a
temp directory and writes the file from them: a generated-file header, the
legend, then every view grouped as landscape and containers, drill-downs,
deployment, today's flows, and the decided `Target` views. Each view gets its
title, its description from the model, a link to it on the
[site](https://stevebargelt.github.io/meatgeekv2/) and its Mermaid. A flow also
gets its numbered steps with their notes, because the Mermaid flowchart keeps
neither. A view in no group goes under "Other views", so a new view is never
dropped; add it to `GROUPS` in the script to place it. The output has no
timestamps, so it is byte-identical on every run and on every OS.

The legend in `diagrams.md` is copied from this README's "The honesty
convention" section, from its first paragraph to the tables and the rule, so
editing that part of the section also means regenerating. If a view's Mermaid
ever stops parsing, fix it in the generator or, as a last resort, list it in
`LINK_ONLY` with a reason: that view then shows only its site link and the
reason, never nothing.

Because `check` fails on a stale file, a hand edit to `diagrams.md` fails CI.

## The honesty convention

The model shows what the code on `main` actually does, and marks everything else.
Every element and relationship that is not plainly live says so.

Element tags (defined in `spec.c4`, styled in `views.c4`):

| Tag         | Use it when                                                                            |
| ----------- | -------------------------------------------------------------------------------------- |
| `#live`     | It is on `main` and runs in the deployed environment today.                            |
| `#scaffold` | Code exists on `main` but is a stub or is not wired up, so it does not do the job yet. |
| `#notBuilt` | Nothing on `main`, and no decision to build it yet. Drawn faded.                       |
| `#decided`  | The owner has decided to build it, but it is not on `main` yet.                        |
| `#retiring` | It is on `main` today and has been decided for removal.                                |

Relationship kinds (`a -[kind]-> b`; a plain `->` means "live today"):

| Kind       | Use it when                                                                |
| ---------- | -------------------------------------------------------------------------- |
| `planned`  | The connection is not built, and there is no decision to build it yet.     |
| `decided`  | The connection is decided and will be built, but is not on `main` yet.     |
| `retiring` | The connection exists in the code today and is going to be removed.        |
| `event`    | An asynchronous message (queue, event stream, IoT Hub route) that is live. |

**The rule:** a view that shows current state never draws a decided or not-built
path as if it were live. Decided designs go in their own views, whose id ends in
`Target` (for example `probeAlertTarget` in "Add a flow" below). A current-state view
may still include a `#decided` or `#notBuilt` element, because the view styles
render those dashed or faded, but its flows describe only what runs today.

`scripts/check-honesty.mjs` enforces this. It fails when:

1. a view whose id does not end in `Target` (and is not `deviceUpdates`) draws an
   edge touching a `#decided` or `#notBuilt` element with a relationship that is
   not of kind `decided`, `planned` or `retiring` (a flow step with no model
   relationship behind it counts as live);
2. a flow whose id does not end in `Target` has a step from or to a `#decided`
   element;
3. a `decided` relationship lacks `#decided`, a `planned` one lacks `#notBuilt`,
   or a `retiring` one lacks `#retiring`. Tag the relationship as well as giving
   it the kind.

## Add an element

Elements live in `model.c4`, nested under their parent. Pick an element kind from
`spec.c4` (`app`, `component`, `service`, `store`, `collection`, `stream`, ...),
give it an id, a title, and an honesty tag. For example, a component inside the
API that is not built yet:

```likec4
model {
  meatgeek = system 'MeatGeek V2' {
    cloud = area 'MeatGeek cloud' {
      api = app 'Functions API' {
        // ... existing components ...

        alerts = component 'alerts' {
          #notBuilt
          technology 'TypeScript'
          description 'Sends a push notification when a probe reaches its target temperature.'
        }
      }
    }
  }
}
```

In the real file you add only the `alerts = component ...` block inside the
existing `api` element; the outer blocks are shown for context. Its full id is
`meatgeek.cloud.api.alerts`.

Then connect it, inside the `model` block, with the relationship kind that
matches its state:

```likec4
meatgeek.cloud.api.alerts -[planned]-> meatgeek.mobile 'push notification' {
  #notBuilt
}
```

When the element ships, change its tag to `#live` and the relationship to a plain
`->` (or `-[event]->` if it is asynchronous) in the same pull request as the code.

## Add a view

Static views live in `views.c4`. A view `of` an element scopes `include *` to
that element's children and their direct neighbours; add anything else by id.

```likec4
views {
  view alerts of meatgeek.cloud.api {
    title 'API: alerts'
    description 'How probe alerts leave the API. Not built.'
    include *
    include meatgeek.mobile, meatgeek.cloud.data.temperatures
  }
}
```

Keep `title` and `description` honest about state: if the view is the decided
design rather than today, its id ends in `Target` and its description says so.
The shared styles at the top of `views.c4` fade `#notBuilt` elements and dash
`#decided` ones in every view automatically; you do not restyle them per view.

## Add a flow

A flow is a `dynamic view`: an ordered list of steps between elements. A step
does not have to match a relationship in `model.c4`, but when it is a lasting
connection, add it to the model too (with the right kind) so the static views
show it. Add `variant sequence` to draw the flow as a sequence diagram.

```likec4
views {
  dynamic view probeAlertTarget {
    variant sequence
    title 'Flow: a probe alert reaches the phone (decided design)'
    description 'Not built. The live reading path up to Event Hub is unchanged.'

    meatgeek.cloud.ingest.eventhub -> meatgeek.cloud.api.broadcast 'reading'
    meatgeek.cloud.api.broadcast -> meatgeek.cloud.api.alerts 'probe at target?' {
      notes 'Only readings for an active cook are checked.'
    }
    meatgeek.cloud.api.alerts -> meatgeek.mobile 'push notification'
  }
}
```

Use `parallel { ... }` for steps that happen at the same time, `notes` for
detail on a step, and `navigateTo <viewId>` to link a step to another view
(for example from a current-state flow to its `Target` counterpart). A flow that
contains any decided or not-built step is a `Target` flow; the current-state flow
next to it stops where today's code stops and says so in its description
(see `telemetry` in `views.c4`, which stops at SignalR because no app connects yet).

After any change, run `npm run check` and look at the result in the preview.
