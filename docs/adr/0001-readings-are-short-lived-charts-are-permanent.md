# Readings are short-lived; a Cook's chart is permanent

In every environment, every **Reading** expires: a Reading taken while no **Cook** is **Active** after 24 hours, and a Reading that belongs to a **Cook** after 7 days. The **Cook**'s chart, built from those Readings as per-minute rollups, is kept forever. A Reading arrives every few seconds, and nothing reads it after the **Cook** ends except the chart, so keeping the raw Readings forever would cost storage without buying anything. Readings outside a **Cook** only show that a **Device** is connected and working, so a day is enough.

## Consequences

- Once a **Cook**'s Readings expire, its chart can no longer be rebuilt or rebucketed from raw data. A change to how the chart is computed applies only to **Cooks** that ended in the last 7 days.
- The expiry depends on whether the Reading belongs to a **Cook**, so it is set on each Reading, not as one default for the whole store.
- This replaces the earlier retention of 7 days in dev and 90 in prod for every Reading, in a **Cook** or not.
