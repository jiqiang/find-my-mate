# find-my-mate

A family location-sharing app: a group of four people see each other's latest position on a live map.

## Language

**Group**:
The one circle of people who can see each other's positions. A phone belongs to exactly one group.
_Avoid_: Family, team, circle

**Member**:
One admitted phone in a group, under a name the rest of the group sees. A member is the app install, not a person's account — the same person on a new phone is a new member.
_Avoid_: User, account, device

**Owner**:
The member who created the group, and the only one who can admit, rename or remove members. There is exactly one, and they cannot leave.
_Avoid_: Admin, host, creator, project owner (a Firebase/Google account concern, not a group role)

**Invite code**:
A short-lived code that lets someone ask to join a group. It points at a group; on its own it grants nothing.
_Avoid_: Password, key, secret, PIN

**Join request**:
A pending ask to become a member of a group, waiting for the owner's approval.
_Avoid_: Application, signup

**First run**:
This phone in no Group, offering to create one or join one. A phone removed from its Group, or one that left, is back at First run.
_Avoid_: Onboarding, welcome, setup

**Waiting**:
This phone with a pending Join request: not yet a Member, and sharing nothing.
_Avoid_: Pending member, lobby

**Position**:
One member's whereabouts at one moment — coordinates, accuracy, and when it was last updated. Only the latest position per member exists; there are no trails.
_Avoid_: Location, fix, ping, trail

**Sharing**:
This phone keeping its own Position up to date for the Group, which it does only while the app is open. Putting the phone away, even briefly, pauses Sharing; nothing is shared on the way out. A single write of a Position is a publish.
_Avoid_: Tracking, broadcasting

**Location gate**:
The check that this phone may share its Position: permission granted and location services on. When it fails, the phone sees why instead of the map.
_Avoid_: Permission check, lock

**Pin**:
A Member's latest Position as the map shows it, labelled with their name and its age, and grey when the Member is Stale. Only Members with a Position have a pin.
_Avoid_: Marker, dot, avatar

**Stale**:
A member whose latest position is more than three minutes old. A stale member is still a member.
_Avoid_: Offline, disconnected, lost
