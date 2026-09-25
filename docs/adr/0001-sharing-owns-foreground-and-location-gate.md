# Sharing owns the foreground signal and the Location gate

Coming back to the foreground has to re-check the Location gate and resume Sharing, and nothing may be shared before the gate says granted. So Sharing is the only listener to the foreground signal: on every return it checks the gate first, and only then resumes and publishes the held reading. The app shell subscribes to the gate's answer to choose between the map and the blocked screen. A Sharing starts once there is a Group and a Member, lasts through both the map and the blocked screen, and holds no watch while blocked.

## Considered Options

- **The app shell listens, checks the gate, then tells Sharing to resume.** Rejected: pausing and resuming would stay split across two modules, and Sharing would lose the seam that lets its lifecycle be tested in Node.
- **Both listen, and Sharing waits for a gate answer passed in from outside.** Rejected: that keeps two listeners for one event, and they stay in the right order only by convention.
