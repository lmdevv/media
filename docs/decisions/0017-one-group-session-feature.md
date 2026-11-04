# 0017. Build group sessions once in the core and let each domain supply its state

- Status: Accepted, 2026-11-03
- Decisions: D34

## Context

Both products let people play together, each in its own way. Movies has watch rooms. A room holds
a shared clock (`positionAtAnchorMs`, `anchorServerTime`), heartbeats keep members present, and the
host alone controls playback (`docs/decisions.md`, "Watch rooms"). Music has jams. A jam is a live
listening session shared from its host's playback, people who join play the host's queue, and jam
links can make guest accounts.

The membership, roles, presence, and clock are the same problem in both. The shared state differs.
A movie session shares one title and a position. A music session shares a queue.

## Decision

- The core has one group-session feature with:
  - a join link,
  - members, with host and guest roles,
  - join settings of open, approval, or locked,
  - permissions to control playback and to add items,
  - presence,
  - a shared clock.
- Each domain supplies its own shared state.
- Each client runs sessions for its own domain only. The movies app runs movie sessions.
- Session items are typed references, so mixed sessions could come later.

## Consequences

- Movies' rooms and music's jams both port onto the core feature, in phase 6.
- A join link that a guest opens goes through the guest rules in ADR 0007.
- A later product brings its own shared state and reuses membership, presence, and the clock.
- No client shows a session from another domain in v1.

## Alternatives rejected

- Separate rooms and jams per product, as today. One core feature replaces both.
- Mixed movie and music sessions now. Typed items leave room for them, and v1 does not build them.

## Edge cases settled

- A locked session takes no new members.
- An approval session holds a new member until the host approves.
- A member without the control permission cannot change playback. A member without the add
  permission cannot add items.
- The movies app never opens a music session, and the music app never opens a movie session.
