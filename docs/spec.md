# Find My Mate — v1 spec

**Status:** decision-complete (2026-09-22). There are no open questions: everything the planning effort left
undecided is decided here.

Vocabulary is the glossary in [`CONTEXT.md`](../CONTEXT.md): **Group**, **Member**, **Owner**, **Invite code**,
**Join request**, **Position**, **Stale**. Use those words in the code, the comments and the UI copy.

This file stands alone. The planning tickets that produced it live in `.scratch/find-my-mate/` and are not
committed, so nothing here depends on reading them.

---

## 1. What v1 is

Four people, one Group, one screen: a full-bleed live map showing the latest Position of each Member, with the
member's name and the age of their Position on the pin. One Member is the Owner and admits everyone else with a
short-lived Invite code. It runs in Expo Go from a dev machine, on Firebase's free Spark plan, with no server
code, no store submission and no paid accounts.

Hard constraints that shape every decision below:

- **Runs in Expo Go** on real iPhones and Android phones — no development build, no TestFlight, no Play Store.
- **Expo SDK 54 exactly.** Expo Go on the App Store stops at SDK 54; Android phones install the SDK 54 build
  of Expo Go from expo.dev/go, because the Play Store build carries a newer SDK and refuses the project.
- **Foreground only.** Location is shared whenever the app is open, and only then. There is no pause, no
  incognito and no read-without-sharing mode.
- **Free tiers only.** Firebase Spark (no Cloud Functions, no Blaze), no Apple Developer account, no Google
  Maps API key, no other paid service.
- **Only the latest Position per Member ever exists** — structurally, not as a promise (§3).
- **The smallest thing that works.** One screen, no router, no state-management library, no abstraction
  layers, no feature that is not in this spec.
- **Accepted runtime:** the dev machine is part of the runtime. If the laptop is asleep or the dev server is
  not running, nobody can open the app. Accepted for v1.

---

## 2. The stack, pinned

| Piece | Choice | Why |
| --- | --- | --- |
| App | Expo **SDK 54**, TypeScript, run in **Expo Go** | The only SDK the App Store Expo Go supports; no build step, no paid accounts. |
| Map | **`react-native-maps` 1.20.1** (the version Expo Go SDK 54 ships), **default providers**, no API keys | Included in Expo Go on both platforms with no config. iOS draws Apple Maps, Android draws Google Maps. |
| Location | **`expo-location`** (Expo Go SDK 54 version), foreground ("when in use") only | Included in Expo Go, no config, no key. Background location is not possible in Expo Go (§11). |
| Backend | **Firebase JS SDK** (`firebase` package): Firestore + Anonymous Auth | The native `@react-native-firebase` SDK needs a development build; the JS SDK is the only Firebase that runs in Expo Go. |
| Local state | **`@react-native-async-storage/async-storage`** (Expo Go version) | Holds `groupId` and the join-time `groupName`/`ownerName`, and backs Firebase Auth persistence. |
| Everything else | React state + Firestore snapshot listeners | No router, no state-management library, no UI kit. |

Map props: use only the surface common to both providers — `initialRegion`, `<Marker>` children,
`showsUserLocation`, `onRegionChangeComplete`, `onPress`, `mapType: "standard"`. Do not use platform-only
props; iOS and Android will never look identical, and that is accepted.

`showsUserLocation` fails silently if permission has not been granted. The map is never shown without
permission (§7.6), so this is satisfied by construction.

### Shape of the code

Keep it to these modules — this is the whole app:

```
App.tsx           the phase switch: loading → firstRun | waiting | map | blocked; nothing else
src/firebase.ts   initializeApp + initializeAuth (AsyncStorage persistence) + getFirestore
src/session.ts    groupId in AsyncStorage; createGroup, join, approve, leave, removeMember, invite rotation
src/location.ts   the watchPositionAsync subscription and publishLocation() — the only Position writer
src/screens/      FirstRun, Join, Waiting, Map, BlockedPermission
firestore.rules   §4, verbatim
firebase.json     points the Firebase CLI at firestore.rules
```

`publishLocation()` being the single write path is load-bearing: it is what makes background tracking a later
change to one function instead of a rework (§11).

---

## 3. Data model

### Identity

- **A Member is an app install.** The member document id is the Firebase anonymous uid. There is no `users`
  collection and no profile object.
- Real accounts later are added by *linking* a credential to the same anonymous account: Firebase upgrades
  the account in place, so the uid — and `members/{uid}` — survive with no migration. Not in v1.
- Accepted cost: **the identity dies with the install.** Reinstalling Expo Go, or clearing its data, makes a
  new person as far as Firestore is concerned. That is a new join (§5).
- Anonymous sign-in must **persist across app restarts** (AsyncStorage-backed Firebase Auth persistence). If
  it did not, every relaunch would be a new Member. Verify this on a real phone before building anything else
  (§10).

### Collections and fields

```
groups/{groupId}        name: string
                        ownerUid: string          // the creator; never changes in v1
                        maxMembers: 4             // soft cap (see §5)
                        createdAt: timestamp
                        activeInviteCode: string | null

  members/{uid}         displayName: string
                        role: 'owner' | 'member'
                        joinedAt: timestamp

  joinRequests/{uid}    displayName: string
                        status: 'pending' | 'approved'
                        requestedAt: timestamp
                        inviteCode: string      // the code that got them in the door

  locations/{uid}       lat: number
                        lng: number
                        accuracy: number        // metres; stored but not rendered in v1
                        updatedAt: timestamp    // server timestamp, not the phone's clock
                        mode: 'foreground'      // the one field background tracking will add to

invites/{code}          groupId: string
                        groupName: string       // so the waiting screen can name the group
                        ownerName: string       // ...and the person to ask ("Ask Sam to approve")
                        createdBy: string
                        expiresAt: timestamp
```

`groupId` is a Firestore random id (20 chars). `code` is the invite document's **id**, so joining is a single
document `get` — no query, so the "rules are not filters" problem never arises.

`createdAt`, `joinedAt`, `requestedAt` and `updatedAt` are written with Firestore's `serverTimestamp()`, never
`Date.now()`. The one exception is `expiresAt`, which is computed on the Owner's phone as its own clock's
"now" + 24 h (a server-timestamp sentinel cannot carry arithmetic); the accepted consequence is noted in §4.

Two structural choices, not promises:

1. **The location document id is the Member's uid.** One document per person, every write overwrites it, so
   history cannot accumulate by accident.
2. **`displayName` lives only on the member document.** The map screen listens to `members` (4 docs, for
   names) and `locations` (4 docs, for Positions) — two listeners, no join, no duplication.

### What is never stored

No location history or trails (structural, above). No speed, heading, battery or altitude. No email, phone
number or photo. No presence or heartbeat documents — "offline" is derived from `locations/{uid}.updatedAt`;
it is never written. No push tokens (no push in v1). No list of groups on a device beyond the one Group it is
in.

---

## 4. Security rules

Rules-only, Spark plan, no Cloud Functions. `get()`/`exists()` are billed as reads and are used sparingly.
`getAfter()` is used exactly once: creating a Group and its Owner-member document in one batch.

Deploy this file verbatim as `firestore.rules`:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function signedIn() { return request.auth != null; }
    function uid() { return request.auth.uid; }

    function groupPath(gid) {
      return /databases/$(database)/documents/groups/$(gid);
    }
    function isMember(gid) {
      return signedIn() && exists(/databases/$(database)/documents/groups/$(gid)/members/$(uid()));
    }
    function isOwner(gid) {
      return signedIn() && get(groupPath(gid)).data.ownerUid == uid();
    }
    // Group creation is one batch: the group doc does not exist yet when the member write is checked.
    function isOwnerAfter(gid) {
      return signedIn() && getAfter(groupPath(gid)).data.ownerUid == uid();
    }
    function approved(gid) {
      return signedIn()
        && exists(/databases/$(database)/documents/groups/$(gid)/joinRequests/$(uid()))
        && get(/databases/$(database)/documents/groups/$(gid)/joinRequests/$(uid())).data.status == 'approved';
    }
    function validInvite(code, gid) {
      return signedIn()
        && exists(/databases/$(database)/documents/invites/$(code))
        && get(/databases/$(database)/documents/invites/$(code)).data.groupId == gid
        && get(/databases/$(database)/documents/invites/$(code)).data.expiresAt > request.time;
    }

    match /groups/{gid} {
      allow get: if isMember(gid);
      allow create: if signedIn()
        && request.resource.data.ownerUid == uid()
        && request.resource.data.maxMembers == 4
        && request.resource.data.keys().hasOnly(['name', 'ownerUid', 'maxMembers', 'createdAt', 'activeInviteCode']);
      // Only the name and the active code are ever editable; ownerUid and maxMembers are frozen.
      allow update: if isOwner(gid)
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['name', 'activeInviteCode']);
      allow delete: if false;                       // a group is never deleted in v1
    }

    match /groups/{gid}/members/{memberUid} {
      allow read: if isMember(gid);
      // The owner admits themselves in the creation batch; a joiner admits themselves only once approved.
      allow create: if signedIn()
        && (memberUid == uid())
        && (
          (request.resource.data.role == 'owner' && isOwnerAfter(gid))
          || (request.resource.data.role == 'member' && approved(gid))
        )
        && request.resource.data.keys().hasOnly(['displayName', 'role', 'joinedAt']);
      // displayName is the only field anyone can change; role and joinedAt are immutable,
      // so a member cannot promote themselves and an owner cannot appoint a second owner.
      allow update: if (isOwner(gid) || memberUid == uid())
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['displayName']);
      // The owner cannot remove themselves: that is how "the owner cannot leave" is enforced.
      allow delete: if isOwner(gid) && memberUid != uid();
    }

    match /groups/{gid}/joinRequests/{requestUid} {
      allow read: if isOwner(gid) || requestUid == uid();
      // Asking needs a live code for *this* group; approval is what grants access.
      allow create: if requestUid == uid()
        && request.resource.data.status == 'pending'
        && request.resource.data.keys().hasOnly(['displayName', 'status', 'requestedAt', 'inviteCode'])
        && validInvite(request.resource.data.inviteCode, gid);
      // The owner approves. There is no 'denied': "Not now" writes nothing.
      allow update: if isOwner(gid)
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['status'])
        && request.resource.data.status == 'approved';
      allow delete: if isOwner(gid) || requestUid == uid();
    }

    match /groups/{gid}/locations/{memberUid} {
      allow read: if isMember(gid);
      allow create, update: if memberUid == uid()
        && isMember(gid)
        && request.resource.data.keys().hasOnly(['lat', 'lng', 'accuracy', 'updatedAt', 'mode'])
        && request.resource.data.lat is number
        && request.resource.data.lng is number
        && request.resource.data.lat >= -90 && request.resource.data.lat <= 90
        && request.resource.data.lng >= -180 && request.resource.data.lng <= 180
        && request.resource.data.updatedAt == request.time     // server clock, not the phone's
        && request.resource.data.mode == 'foreground';         // becomes hasAny(['foreground','background']) when background lands
      allow delete: if isOwner(gid);                            // so removing a member also removes their pin
    }

    match /invites/{code} {
      allow get: if signedIn() && (
        resource.data.expiresAt > request.time                 // any signed-in phone with the code
        || isOwner(resource.data.groupId)                      // the owner may read an expired one to replace it
      );
      allow create: if isOwner(request.resource.data.groupId)
        && request.resource.data.keys().hasOnly(['groupId', 'groupName', 'ownerName', 'createdBy', 'expiresAt'])
        && request.resource.data.createdBy == uid()
        && request.resource.data.expiresAt > request.time;
      allow update, delete: if isOwner(resource.data.groupId);
      allow list: if false;                                     // no enumeration, ever
    }
  }
}
```

Notes the implementer should not have to rediscover:

- **`allow get` without `allow list`** on `invites` is deliberate: `read` = `get` + `list`, and `list` is what
  enumeration would need.
- **Clock skew is tolerated, deliberately.** `expiresAt` is written by the owner's phone, so a wrong clock can
  only mint a code that lives longer than 24 h. Only the Owner can create codes, they point at the Owner's own
  Group, and the code is not the gate — the approval is.
- **The rules are unexecuted.** This is a reviewed sketch, not a tested file. Validating it in the Firestore
  emulator, including the paths in §10, is the first task of implementation — not an open decision.
- **Trust boundary.** Rules prove *who* wrote a Position and *where they were allowed to*. They never prove a
  Position is *true*: a Member can write any coordinates. Rules also cannot rate-limit or ban an abusive
  client, and cannot stop a Member copying what they are allowed to read. For four people who know each other,
  that is the right line.

---

## 5. Membership lifecycle

| Event | What happens |
| --- | --- |
| **Create the Group** (Owner, first run) | An unconfigured phone shows two buttons: *Create a family group* and *Join with a code*. Create asks for the Owner's name and the Group name, writes `groups/{gid}` + `members/{ownerUid}` in **one batch**, saves `groupId` locally, and drops to the map. |
| **Join** (new phone) | Type the code and a name → `get invites/{code}` (fail: *"That code isn't right."*) → write `joinRequests/{uid}` with `status: 'pending'` → waiting screen *"Ask Sam to approve"* → on approval, write `members/{uid}` with `role: 'member'` → map. |
| **Approve** | The Owner's banner (*"Priya wants to join this group."*) sets `status: 'approved'` and rotates the Invite code. No push: the joiner's own request listener picks the change up. |
| **Leave / remove** | One client-side batch deletes `members/{uid}` + `locations/{uid}` + `joinRequests/{uid}`. Deleting the join request matters: an approved request left behind would let a removed phone admit itself back in. The phone whose member document is gone lands on the first-run screen with *"You're no longer in this group."* |
| **Owner leaves** | Not possible in v1. The rules deny the Owner deleting their own member document, and the menu does not offer it. |
| **Invite code** | 24 h. One active code per Group, held in `groups/{gid}.activeInviteCode`. Created on demand (*Invite someone*), rotated automatically when someone is approved. Regenerating **deletes** the old document, so there is no `revoked` field. Wrong, expired and already-used codes are indistinguishable to the app: all read as *"That code isn't right."* |
| **Cap** | `maxMembers: 4` is a **soft** cap: Firestore rules cannot count documents, so the Owner's client refuses to approve into a full Group. The spec says so honestly rather than pretending the rules enforce it. |
| **A new phone** | A new install is a new uid, so it is a normal join — but the Owner must **remove the old Member first, then approve the replacement**: at 4/4 the Owner's client refuses to approve into a full Group, so approve-then-remove would deadlock exactly when the recipe is needed (§9). |
| **The Owner's phone dies** (lost, or Expo Go reinstalled — which deletes the app data) | Accepted cliff. The Group keeps sharing Positions, but nobody can approve, invite or remove: the old `ownerUid` has no phone. Recovery: the Owner creates a fresh Group on the new phone and the others tap *Leave group* and rejoin with the new code. The dead Group's documents are simply orphaned (a handful of documents, free tier). |

---

## 6. The location policy: how live "live" is

### Publishing

- Ask for **when-in-use permission only** — no `UIBackgroundModes`, no `ACCESS_BACKGROUND_LOCATION`, no Play
  Store declaration. iOS "Approximate" is a granted permission, not a blocked one: the pin is simply coarse.
- Accuracy: `Accuracy.High` (≈10 m — the pin lands on the right house).
- One `watchPositionAsync({ accuracy: Accuracy.High })` subscription holds the latest fix. A 30-second JS
  timer publishes that fix through `publishLocation()`. The timer must be JS: `timeInterval` is Android-only.
- Publish **immediately**, not just on the timer, when: the map opens, the app returns to the foreground, and a
  join is approved.
- Every write sets `updatedAt` with the Firestore **server timestamp** and `mode: 'foreground'`. Never the
  phone's clock.
- Publish every fix the OS reports; store `accuracy`; do not gate on it and do not render it in v1.

### Stopping

- Backgrounding or locking the phone stops the timer and the subscription. **Nothing is written on the way
  out** and there is no offline marker.
- A killed app simply stops publishing. Reopening after hours updates the map with no "welcome back" message.
- Silence is normal and is never a membership change: a silent Member stays a Member forever.

### Age and Stale

- Age is `now − updatedAt` (server receipt time), re-rendered on a 15-second ticker with no new data needed.
- Wording: **"now"** under 60 s → **"N min"** under 60 min → **"N h"** under 24 h → **"N d"**.
- Ages compare the phone's clock against the server timestamp. A phone with a badly wrong clock shows wrong
  ages; small skew is accepted, and nothing in v1 depends on this being exact.
- A Member is **Stale** after 3 minutes with no update: their pin turns grey; they stay on the map and in the
  member list. Their age keeps ticking.
- `updatedAt` means **last confirmed by this phone**, not *measured at this instant*: the heartbeat republishes
  the last fix, so a queued write can briefly show an old Position as fresh. It self-corrects on the next
  30-second publish.
- A Member with no location document (never published) has **no pin** and reads "No position yet" in the
  member list.

### Blocked state: no location means no app

There is no read-without-sharing mode, so the map is **never** shown behind these screens. Two full-screen
variants, re-checked every time the app returns to the foreground (which also covers iOS "Allow Once"
expiring):

- Permission denied:
  > Find My Mate needs your location — the map only works while you're sharing where you are.

  with **[ Open Settings ]** and **[ Try again ]**.
- Location services off:
  > Turn on location — your phone's location services are off, so the map can't show anyone.

  with the same two buttons.

### Failed writes

No error UI. Firestore queues writes made while offline and lands them on reconnect. The next 30-second
publish corrects the Position anyway.

### Cost at this cadence

Spark includes 20,000 writes, 50,000 reads, 20,000 deletes per day and 1 GiB stored. Four phones open 4 h/day
at 30 s ≈ **1,920 writes/day** (10% of the write cap); each write fans out to the other three phones ≈ 5,760
listener reads, plus a few rules reads per operation — comfortably inside the read cap. All four phones open
24 h would be 11,520 writes/day (58%) with reads approaching the cap, which is one more reason v1 is
foreground-only. A 15 s cadence would risk the cap outright; 30 s is the decision.

---

## 7. Screens and behaviour

### 7.1 The phase switch

`App.tsx` holds exactly one decision, checked in this order (the order matters):

1. No stored `groupId` → **First run** (§7.2).
2. Stored `groupId` + own join request `pending` → **Waiting** (§7.3).
3. Stored `groupId` + own join request `approved` + no own member document → write `members/{uid}`, then
   **Map** (§7.4). This is the approved-while-the-phone-was-closed case: the joiner finishes materialising
   its own membership on the next launch.
4. Stored `groupId` + no join request + no own member document → **First run**, with *"You're no longer in
   this group."*
5. Stored `groupId` + own member document present → **Map** (§7.4), after the location permission gate
   (§7.6).

Nothing else navigates. There is no back stack.

### 7.2 First run

```
Find My Mate

[ Create a family group ]
[ Join with a code ]
```

**Create**: two fields — *Your name* and *Group name* — and a **[ Create ]** button. (The Owner's name is
needed by the same model as everyone else's: it is the `displayName` on their member document, the label on
their pin, and the `ownerName` on every invite they mint.) Create writes `groups/{gid}` +
`members/{ownerUid}` in one batch, stores `groupId`, asks for location permission, then shows the map. No
invite code is minted yet; the Owner mints one when they need it.

**Join**: one screen with two fields — *Code* and *Your name* — and a **[ Join ]** button. On a bad, expired
or already-used code: *"That code isn't right."* stays on screen and the fields keep their values.

Joining stores `groupId`, `groupName` and `ownerName` locally (all three come from the one read of the invite
document). The Group id is what the phase switch keys on; the two names are what the waiting screen needs to
say whose approval to wait for after the app is killed and reopened.

### 7.3 Join flow and the waiting screen

1. Join screen (§7.2) → `get invites/{code}` → write `joinRequests/{uid}` with the typed name and
   `status: 'pending'`.
2. Waiting screen:

   > **Ask {ownerName} to approve**
   >
   > We'll let you in as soon as {ownerName} approves.

   The screen subscribes to its own join-request document (a snapshot listener — the sketch's 10-second poll
   was the fallback shape of the same requirement; a listener is fewer reads and lands sooner). Killed and
   reopened, the phone returns here while the request is pending. There is no cancel in v1 (§12).
3. On `approved`, the phone writes `members/{uid}` with `role: 'member'` and shows the map with a one-off
   banner: *"Welcome, {name}. You are sharing your location with the family."*, then the banner disappears.

### 7.4 The map

Full-bleed map. The screen has no chrome beyond: the Group name and menu button on top, pins, the recentre
button, the Owner's join-request banner when a request is pending, and the "No one is sharing yet" line when
it applies.

- **Pins.** One per Member with a Position, including yourself. Label: `{name} · {age}` — e.g. `Priya · 2 min`,
  `Sam · now`. One name, one age, no legend.
- **Stale pins** (> 3 minutes) are grey; the label keeps the same shape.
- **Camera.** On open, fit every pin (including your own) with padding. If nobody has a Position yet, wait
  for your first fix and centre there. Tapping a member row centres that Member at the recentre button's zoom.
- **Recentre button** (⦿, bottom right) centres the map on you, zoomed to roughly a neighbourhood
  (`latitudeDelta` ≈ 0.01).
- **Nobody else sharing yet:** the map shows your pin and a single line on top — *"No one is sharing yet. Ask
  them to open the app."*

**Member list lives in the ⋯ menu.** The reaction to the sketch made the map full-bleed and left the list
homeless; the sketch itself suggested the menu, and this spec puts it there. *⋯ → Members* shows one row per
Member:

- `{name} · updated {age} ago` — e.g. `Priya · updated 2 min ago`
- `You · sharing on`
- `{name} · No position yet` for a Member with no location document

Tap a row to close the menu and centre the map on that Member. Each row also carries a trailing edit
affordance, separate from the tap:

- your own row: *Rename* (updates your `displayName` only) — this is the rule that lets a Member rename
  themselves;
- the Owner's view of every other row: *Rename* and *Remove from group* (the leave/remove batch in §5, with a
  confirmation).

No one can rename or remove another Member except the Owner.

### 7.5 The menu and the Owner's job

The ⋯ menu contains exactly:

```
Members
Join requests (n)     only when n > 0
Invite someone
Leave group
```

There is no sharing switch. In particular, "Stop sharing my location" — present in the first sketch — does
not exist in v1.

**Join requests (n)** opens the pending list. The Owner's banner appears over the map whenever a pending
request exists:

> **Priya wants to join this group.**
> [ Approve ]   [ Not now ]

*Approve* sets `status: 'approved'` and rotates the Invite code. *Not now* writes nothing: it hides the banner
for this session, and *⋯ → Join requests (n)* keeps it findable. The banner returns next session while the
request is pending.

When the Group already has four Members, the request still appears, but Approve is not offered: the banner
says *"This group is full. Remove someone first."* The cap is enforced here on the Owner's client, because
rules cannot count documents (§5).

**Invite someone** shows the current code large enough to read aloud, with *"Read this out to whoever is
joining. It works until {time}."* and a **[ New code ]** button. Opening it with no live code mints one: 8
characters from the unambiguous 32-character alphabet `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (no `0/O`, no
`1/I/L`; ~40 bits), expiry 24 h, written as `invites/{code}` and `groups/{gid}.activeInviteCode`. *New code*
creates the replacement first, then deletes the old document. **The code is not the gate** — it only points at
the Group; the Owner's approval is the gate.

**Leave group** confirms first: *"Leave this group? You'll need a new invite code to come back."* On confirm,
run the leave/remove batch, clear the stored `groupId`, and land on First run. The Owner is not offered this
item.

### 7.6 The location gate

Before the map is shown, and again every time the app returns to the foreground:

- permission not yet asked → trigger the OS prompt once;
- permission granted (including iOS Approximate) → the map;
- permission denied → the permission-denied screen (§6);
- location services off → the location-services screen (§6).

Granting permission from Settings and tapping *Try again* moves the phone to the map and publishes at once.

---

## 8. Firebase setup

Do this once, when the app is built:

1. **Create a new project** in the user's Google account, named `find-my-mate` (Firebase appends a suffix if
   the project id is taken), on the **Spark** plan.
2. **Add a second owner** — another adult's Google account — so one lost account cannot strand the family's
   data. (This is the *Firebase project owner*: a Google account. It is not the app's **Owner** role.)
3. **Enable Anonymous Auth.**
4. **Create the Firestore database in `australia-southeast1` (Sydney).** The location is permanent and cannot
   be changed later; Sydney is closest to the family and keeps the data in Australia.
5. **Stay on Spark.** No Cloud Functions (deploying them would require Blaze), no scheduled jobs, one free
   Firestore database.
6. **No App Check in v1.** It cannot attest Expo Go; Firebase Security Rules are the boundary.
7. **Copy the `firebaseConfig` values into `src/firebase.ts` and commit them.** The `apiKey` is public by
   design; the security rules are what protect the data.
8. **Commit `firestore.rules` (§4) and `firebase.json`**, and deploy with
   `firebase deploy --only firestore:rules`.
9. **Run the rules paths in the emulator before the first phone test** (§10).

No composite indexes are needed: every read is a single-document `get` or a whole-subcollection listener.

---

## 9. Running and testing on the four phones

### How it runs day to day

- On the dev machine: `npx expo start`. Phones scan the QR code from Expo Go, on the same Wi-Fi by default.
- If the phones are not on the same Wi-Fi, or the network blocks local connections:
  `npm i -g @expo/ngrok` once, then `npx expo start --tunnel`. Slower; needs internet on both sides.
- iPhones: Expo Go from the App Store (the SDK 54 build). Android: the **SDK 54** Expo Go from expo.dev/go,
  not the Play Store build.
- The dev machine is part of the runtime. Laptop asleep or dev server stopped means nobody can open the app.

### First time, with all four phones in the room

1. With the dev machine awake and `npx expo start` running (add `--tunnel` if needed).
2. Install Expo Go on each phone as above. Each phone uses its own store account; a child's iPhone may need a
   parent's approval to install.
3. Open Expo Go and scan the QR code the dev machine shows. Allow anything Expo Go asks for to reach it.
4. Allow location **while using the app** (precise, if the phone offers the choice). The app shows no map
   without it.
5. First phone: tap **Create a family group**, type your name and the group name. The other three: tap
   **Join with a code**, type the code the Owner reads out, and type their name.
6. Owner: tap **Approve** on each request as it appears. The map appears on every phone, and sharing is on
   whenever the app is open.

### A Member's phone is replaced

1. Owner: remove the old phone from the member list — this frees the fourth slot.
2. On the new phone: install Expo Go, open the app, tap **Join with a code**, enter the Owner's current code,
   and type the name.
3. Owner: approve the request. Nothing else to clean up.

### The Owner's phone is lost or reinstalled

1. Owner, on the new phone: install Expo Go and tap **Create a family group**.
2. Everyone else: open the app → **⋯ → Leave group**.
3. They tap **Join with a code**, enter the new Owner's code, and the Owner approves each of them.
4. The old Group is abandoned — its documents sit there unread, and there is no way back into it.

### Acceptance test, on the four real phones

1. Fresh phone creates a Group; three others join with the code and are approved; all four pins appear on all
   four phones, labelled with names.
2. Ages tick without new writes; a phone closed for more than 3 minutes greys out for the others and keeps the
   Group otherwise unchanged.
3. Backgrounding a phone writes nothing; returning to the foreground updates its pin within a second or two.
4. Deny location on one phone: no map, the blocked screen appears; granting it from Settings and tapping
   *Try again* shows the map.
5. A wrong code shows *"That code isn't right."* and nothing is written.
6. A stale pending request: *Not now* hides the banner, *Join requests (1)* still lists it, relaunching brings
   the banner back.
7. At 4/4 the Owner's client refuses to approve a fifth; removing a Member frees the slot, and the removed
   phone lands on *"You're no longer in this group."*
8. A pending joiner kills the app; the Owner approves; reopening the app lands the joiner on the map without
   them re-entering anything.
9. Rename yourself, and as Owner rename another Member: the new names appear on every phone's pins and member
   list.
10. Leave group on one phone removes its pin everywhere, and the phone cannot get back in without a new code.
11. Kill and relaunch a phone: it is the same Member (auth persistence), not a new one.
12. After a normal day's use, the Firebase console shows usage well inside Spark's caps.

---

## 10. First tasks of implementation

Three things to verify before building the screens, because everything else rests on them:

1. **Expo Go hello.** Create the SDK 54 Expo TypeScript app, add `react-native-maps` 1.20.1 and
   `expo-location`, and get the map rendering in Expo Go on one iPhone and one Android phone. This proves the
   SDK pin and the map choice before any Firebase work.
2. **Rules in the emulator.** The rules in §4 are unexecuted. Validate at least: the create-Group batch
   succeeds and a non-member cannot read the Group; an invite can be `get` by a signed-in stranger but not
   `list`ed; a join request with a bad or expired code is denied; an unapproved uid cannot create its member
   document but an approved one can; a non-member cannot read or write `locations`; a Member cannot write
   another Member's Position; a Position with a client-clock `updatedAt` is denied; a removed Member cannot
   recreate its member document.
3. **Identity persistence.** Configure anonymous Auth with AsyncStorage-backed persistence, then kill and
   relaunch the app on a real phone and confirm the uid is unchanged. If this fails, every relaunch is a new
   Member and the whole model breaks.

One consistency check to keep honest while building: nothing in this app may write a Position outside
`publishLocation()`, and nothing may store a Position outside `locations/{uid}` (one document, overwritten).

---

## 11. Background location: the door v1 leaves open

v1 is foreground-only because **background location cannot run in Expo Go at all**: Expo's SDK 54 docs say
iOS background location "must use a development build … since it is not supported in the Expo Go app", and on
Android "foreground and background services are not available in Expo Go". Going background later would cost
a development build on all four phones, the iOS "Always" permission with its App Review justification,
Android `ACCESS_BACKGROUND_LOCATION` plus a persistent-notification foreground service and a Play Store
core-feature declaration, and ongoing vendor battery-killer maintenance. Even then, background updates stop
when the user terminates the app.

So v1 does four cheap things now, and nothing more:

1. Every Position write goes through `publishLocation()` — a background task later calls the same function.
2. Every Position stores `updatedAt` (server timestamp) and `mode: 'foreground'`; the rules' `mode` check
   becomes `hasAny(['foreground', 'background'])` when background lands.
3. It requests **when-in-use only**. No `UIBackgroundModes`, no `ACCESS_BACKGROUND_LOCATION`, no Play
   declaration.
4. The UI treats silence as normal, because updates stop when the app closes.

---

## 12. Out of scope for v1

- **Background / closed-app location tracking.** v1 is foreground-only; §11 is the whole of what it leaves
  room for.
- **Location history and trails.** Only the latest Position per Member exists.
- **Chat, geofences, arrival alerts, push notifications.** No push of any kind; the Owner finds join requests
  by opening the app.
- **Web dashboard, more than one Group per Member, offline support, battery optimisation.**
- **Real accounts and account recovery** (email, Apple, Google sign-in). Firebase anonymous auth only; the
  identity dies with the install.
- **App Store / Play Store submission and store compliance.**
- **Reading the map without sharing your own location** — no pause, incognito or "stop sharing" affordance.
  Sharing is on whenever the app is open, and a phone without location permission sees no map at all.
- **Ownership recovery without starting a fresh Group.** An Owner who loses their phone (or clears Expo Go's
  data) makes the Group unadministerable; v1 documents the "new Group, everyone rejoins" recipe (§9)
  instead. The only real fix is real accounts, already out of scope.
- **Withdrawing or denying a pending Join request.** "Not now" writes nothing, and the joiner's waiting screen
  has no cancel: the request stays pending until the Owner approves it. The rules permit deletion; the v1 UI
  does not offer it.
- **Distribution beyond Expo Go** — TestFlight, Play internal testing, an EAS-built Android APK, or EAS
  Update as a delivery mechanism. v1 runs in Expo Go from the dev machine.
- **Provisions for scale**: more than four Members, more than one Group, presence records, rate limiting on
  invite attempts, or any server-side code. The client-trust boundary in §4 is accepted.

---

## 13. Open questions

None. This document is the destination: an implementer can start at §10 and build the whole app without
stopping to ask a question. If building it surfaces one, that is a new planning effort, not a gap in this
spec.
