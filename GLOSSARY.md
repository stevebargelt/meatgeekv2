# MeatGeek

Monitoring and managing BBQ cooks: what a smoker and the meat in it are doing during a **Cook**.

## People

**User**:
A person signed in to MeatGeek.
_Avoid_: Pitmaster, Pit Boss, account, customer

**Owner**:
The **User** who claimed a **Device**. A **Device** has at most one **Owner**, and only the **Owner** can start or stop a **Cook** on it. An **Owner** sees only **Readings** taken after their **Claim**.
_Avoid_: Pitmaster, Pit Boss, admin

**Watcher**:
A **User** whom an **Owner** invited to follow one **Cook**. A **Watcher** sees that **Cook** but cannot change it, and sees nothing else on the **Device**. Not built.
_Avoid_: Guest, follower, viewer

## Hardware

**Device**:
A MeatGeek Raspberry Pi. It connects to a **Smoker** and keeps its identity when it is moved to a different **Smoker**.
_Avoid_: Controller, Pi, MeatGeek (for the hardware alone)

**Claim**:
A **User** becoming a **Device**'s **Owner** by entering the **Claim Code** it shows. It is the only way a **Device** gets an **Owner**, and a **Device** that already has one cannot be claimed.
_Avoid_: Register, pair, add, link

**Claim Code**:
A short-lived, single-use code a **Device** shows to prove that whoever enters it has the **Device** in hand.
_Avoid_: Pairing code, PIN

**Release**:
An **Owner** giving up a **Device** so it can be claimed again. Their **Cooks** on it stay theirs. A **Device** cannot be released during an **Active** **Cook**. A factory reset of the **Device** also releases it, so whoever holds the **Device** can always reclaim it.
_Avoid_: Unclaim, remove, delete, unpair

**Port**:
A socket on a **Device** that a **Probe** plugs into: one **Smoker Port** and four **Food Ports**, numbered 1 to 4. A **Port** keeps its **Calibration** whichever **Probe** is plugged in.
_Avoid_: Channel, slot, jack, probe1–probe4

**Calibration**:
The adjustment for one **Port**'s circuit, set by the **Owner** and applied on the **Device** before a **Reading** is sent. A **Reading** is always calibrated, so changing a **Calibration** never changes a past **Reading**.
_Avoid_: Correction, offset

**Live**:
A **Device** whose latest **Reading** is recent. **Live** outranks **Online**.
_Avoid_: Streaming, active (for a **Device**)

**Online**:
A **Device** connected to MeatGeek but not **Live**. It can still learn that a **Cook** started and get software updates.
_Avoid_: Connected, idle

**Offline**:
A **Device** not connected to MeatGeek.
_Avoid_: Disconnected, unknown

**Smoker**:
The physical cooker a **Device** connects to. MeatGeek does not track it as an entity. Some **Smokers** run hot enough to grill on; grilling is something done on a **Smoker**, never another name for it.
_Avoid_: Grill, pit, cooker

**Probe**:
A temperature sensor plugged into a **Port** on a **Device**. Each one is either a **Smoker Probe** or a **Food Probe**.
_Avoid_: Sensor, RTD

**Smoker Probe**:
The **Probe** that measures the air temperature inside the **Smoker**. It plugs into the **Smoker Port**.
_Avoid_: Grill probe, grill temp, pit probe, ambient probe

**Food Probe**:
A **Probe** that measures the internal temperature of a **Cut**. It plugs into one of the four **Food Ports**.
_Avoid_: Meat probe, probe1–probe4

## Cooking

**Cook**:
One session of cooking food on a **Smoker** watched by one **Device**, from start to finish. A **Device** has at most one **Active** **Cook** at a time.
_Avoid_: Session, smoke

**Cut**:
One piece of meat in a **Cook**, on its own **Food Probe**. One **Cook** can hold **Cuts** of different kinds, such as a brisket and two pork butts.
_Avoid_: Item, piece, meat (for a single piece)

**Smoker Target**:
The temperature the **Owner** has set the **Smoker** to. A **Cook** has one at a time, and it can change during the **Cook**. MeatGeek does not control the **Smoker**, so changing it is up to the **Owner**.
_Avoid_: Grill target, setpoint, pit temp

**Smoker Ready**:
The moment a **Cook**'s **Smoker Probe** first enters its **Smoker Range**, sent to the **Owner** as a **Notification**. Changing the **Smoker Target** makes it pending again. The **Smoker** cannot be out of its **Smoker Range** before **Smoker Ready**, so warming up never raises an **Alarm**.
_Avoid_: Up to temp, preheated, grill ready

**Milestone**:
A **Food Probe** temperature for one **Cut** that calls for an action, such as wrapping it, raising the **Smoker Target** or pulling it. A **Cut** has zero or more; reaching one prompts the **Owner**, who decides what to do.
_Avoid_: Done temp, target temp, alarm

**Rest**:
The optional end of a **Cook** after the **Cuts** are pulled, with **Food Probes** still in them. The **Cook** stays **Active** while it lasts. Not built.

**Planned**:
A **Cook** scheduled for the future, with its preparation steps. It needs no **Device** yet. Not built.

**Active**:
A **Cook** that is underway. Its **Device**'s **Readings** belong to it.
_Avoid_: Running, in progress

**Completed**:
A **Cook** that finished normally.
_Avoid_: Done, finished, stopped

**Cancelled**:
A **Cook** that was abandoned before it finished, such as when the **Smoker** broke. It is still kept as a record of the **Cook**.
_Avoid_: Aborted, failed

A **Cook** is never paused: a stop and restart within one smoke is still one **Active** **Cook**.

**Reading**:
The temperatures of all of a **Device**'s **Probes** at one moment. A **Reading** taken while no **Cook** is **Active** belongs to no **Cook** and is only for checking that the **Device** is connected and working.
_Avoid_: Telemetry, sample, data point

**Recipe**:
A **User**'s reusable plan for cooking a kind of meat, such as smoking or grilling it, with its **Smoker Targets** and **Milestones**. A **Cook** started from a **Recipe** copies it, so a later edit to the **Recipe** never changes a past **Cook**.
_Avoid_: Template, plan

**Probe Line**:
The line on a **Cook**'s chart for one **Probe**: a **Smoker Probe** line or a **Food Probe** line.
_Avoid_: Channel, series

**Log Entry**:
A note with a time, written during an **Active** **Cook**, that can carry photos. Acting on a **Milestone** writes one for the **Owner**.
_Avoid_: Note, comment, journal

**Review**:
The **Owner**'s verdict on a **Completed** or **Cancelled** **Cook**: a rating and notes for the whole **Cook**, with an optional line per **Cut**. It can be edited at any time.
_Avoid_: Rating, feedback, debrief

**Smoker Stability**:
The share of a **Cook** the **Smoker** spent inside its **Smoker Range**.
_Avoid_: Temperature stability, consistency

## Alarms and Notifications

**Alarm**:
A problem during an **Active** **Cook** that the **Owner** must act on: the **Smoker** is out of its **Smoker Range**, a **Food Probe** is lost, or the **Device** is silent. There are no **Alarms** outside an **Active** **Cook**. An **Alarm** repeats until the **Owner** acknowledges it, even in quiet hours.
_Avoid_: Alert, warning, alarm (for a **Milestone**)

**Smoker Range**:
How far the **Smoker Probe** may drift from the **Smoker Target**, in either direction, before an **Alarm**. It is set per **Cook**, from the **Recipe** or the **Owner**'s default, and moves with the **Smoker Target**.
_Avoid_: High/low threshold, tolerance

**Food Probe Lost**:
An **Alarm** for a **Food Probe** that stops reading during a **Cook**, because it was unplugged or fell out of its **Cut**.
_Avoid_: Probe disconnected, unplugged

**Device Silent**:
An **Alarm** for a **Device** that is not **Live** during an **Active** **Cook**.
_Avoid_: Device offline, disconnected, stale

**Notification**:
How a **Milestone** or an **Alarm** reaches a **User**, such as a push, a sound or an email. A **Watcher** can choose to get **Milestones** but never gets **Alarms**. The **Owner** gets every **Milestone** and **Alarm** of their **Cook**, even in quiet hours; quiet hours hold back only a **Watcher**'s **Milestones**.
_Avoid_: Alert, message
