---
clickup-task-id: AITAI-256
---

# SQLSTATE[HY000]: General error: 2006 MySQL server has gone away

## Source
- Slack thread: https://aitaijapan.slack.com/archives/C07K4FVHJFN/p1780985269732919
- New Relic issue: https://onenr.io/0EjOaxPKOw6

## Root Cause Checklist
1. Confirm whether DB restart/failover happened at the same timestamp.
2. Check MySQL error log for:
	- `Aborted connection`
	- OOM/restart messages
	- network timeout messages
3. Check DB saturation at incident time:
	- CPU and memory spikes
	- IOPS/latency spikes
	- connection usage near `max_connections`
4. Check MySQL counters before/after incident:
	- `Aborted_clients`
	- `Aborted_connects`
	- `Threads_connected`
	- `Max_used_connections`
5. Verify timeout and packet settings:
	- `wait_timeout`
	- `interactive_timeout`
	- `net_read_timeout`
	- `net_write_timeout`
	- `max_allowed_packet`
6. Confirm if failures happen only on specific product saves:
	- if yes, inspect payload size (large attributes/descriptions/media metadata)
	- check for unusually large serialized data in EAV attributes
7. Correlate app traces with infrastructure events in New Relic around the same minute.

## Recommended MySQL Baseline (Starting Point)
- `max_allowed_packet = 64M` (or `128M` if large payloads are common)
- `wait_timeout = 600` (increase if current value is very low)
- `interactive_timeout = 600`
- `net_read_timeout = 60`
- `net_write_timeout = 60`
- `max_connections`: set with headroom above peak `Max_used_connections`

## Validation Steps After Changes
1. Restart or apply parameter group changes as required by your environment.
2. Re-test `catalog/product/save` on previously failing products.
3. Monitor 24h for recurrence in New Relic and MySQL aborted connection counters.
4. Record before/after values for all adjusted parameters in this task.

## Expected Outcome
- No `SQLSTATE[HY000]: 2006 MySQL server has gone away` during product save.
- Stable rollback/transaction behavior in Magento admin writes.
