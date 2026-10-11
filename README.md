# @opencore-mes/copilot

The copilots of [OpenCore MES](https://opencoremes.com): the designer's, which drafts changes to the plant's model
inside a change request; the integration monitor's, which reads the runs and explains why something fails; and the
analytics copilot of AI Report, which reads the plant's data and draws a report. One package, released on its own,
and taken up by a running OpenCore MES server **without a restart**.

It reaches the core through one published contract, `copilot-host`, and nothing else. The core keeps every decision
about what a copilot may read or change (the tools, run as the person who asks; review, approval and execution stay
with people), and the package decides how to ask a model and what to say. So the copilots' instructions, their loop,
their models and providers, and their chat panels improve without a core release.

## What is in it

| | |
| --- | --- |
| `copilot.json` | its name, version, the `copilot-host` versions it is built for (`host`), its roles and its client |
| `server/index.js` | `activate(host)`: the roles' services, `ai`, `busy()`, `close()` |
| `server/runtime.js` | one conversation loop for every role: steps, tool calls as the person, kept by the host |
| `server/roles/` | the designer's, the monitor's and the analyst's: their tools, rules and words |
| `server/providers.js` | the models: Claude (`AI_PROVIDER=anthropic`) or any OpenAI-compatible API (`AI_PROVIDER=openai`) |
| `skills/` | the instructions, as text |
| `client/` | the panels (`register(juris, kit, { tag })`) and their styles |

## Installing a version on a running server

```bash
opencore-mes copilot install            # the newest, from npm, beside the versions there
opencore-mes copilot use 0.2.0          # every server takes it up within 30 s; what is being answered finishes first
opencore-mes copilot list
```

A version that cannot be taken up (it fails to start, or is built for another `copilot-host`) leaves the one in use
running, and `list` says why. The version shipped with the core is always there to go back to.

## Developing

```bash
npm install
npm test                                              # the roles on a fake host, the providers, the boundary
node <core>/docs/contracts/copilot-host/kit.mjs .     # the contract's kit, from an OpenCore MES checkout
COPILOT_FROM=$PWD npm run dev                          # in the core's checkout: this working copy answers
```

The package imports nothing of the core; its browser files import nothing at all but their own (what they draw with
is the core's `kit`) and keep to the core's browser floor (Safari 15.4, Chrome 93, Firefox 92).

## License

Apache-2.0
