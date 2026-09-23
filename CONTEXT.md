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

**Position**:
One member's whereabouts at one moment — coordinates, accuracy, and when it was last updated. Only the latest position per member exists; there are no trails.
_Avoid_: Location, fix, ping, trail

**Stale**:
A member whose latest position is more than three minutes old. A stale member is still a member.
_Avoid_: Offline, disconnected, lost
