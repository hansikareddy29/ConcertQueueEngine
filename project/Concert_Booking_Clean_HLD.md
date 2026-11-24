# Concert Ticket Booking System
## High-Level Design
Sub-theme 1: Virtual Queue-Based Booking
Final consolidated design baseline | 19 November 2026
Status: proposed implementation; performance targets require benchmark verification.

# 1. Project objective
Design and evaluate a concert ticket-booking application that manages high demand using a virtual queue and a fixed number of payment gateways. Every accepted booking attempt enters the queue. When a gateway becomes free, the next waiting user is assigned to it. A seat is confirmed only after verified successful payment.
The system must maintain consistent booking transactions and prevent duplicate seat allocation while supporting the required concurrent and cumulative request workload.

# 2. Confirmed requirements and design assumptions
## 2.1 Workload requirements
- Handle 500 concurrent HTTP requests in flight.
- Process 100,000 total HTTP requests over a complete evaluation run.
- Use the concert example of 20,000 available seats.
- Deploy within the allotted 10 vCPU cores and 10 GiB RAM resource budget, with application scaling across additional systems when actually provided.
Five hundred is simultaneous request concurrency, not the number of payment gateways. One hundred thousand is cumulative HTTP traffic, not necessarily distinct users, queue entries or confirmed bookings. Queue joins, status reads and booking reads all count as HTTP requests in the mixed-workload benchmark.
## 2.2 Sub-theme requirements
- One logical virtual queue for accepted booking attempts for the concert.
- Fixed payment-processing capacity during each test run.
- Next-user assignment after a gateway transaction terminates and capacity is safely released.
- Successful-payment-only confirmation.
- Evaluation of queue behavior, consistency and duplicate-allocation prevention.
## 2.3 Explicit implementation assumptions
FIFO is the baseline queue policy. Each booking attempt requests one automatically assigned seat. Each configured simulated payment gateway processes one active transaction at a time; three gateways are used in examples, not prescribed as the final count. Configure the count before each run and keep it constant during that run.
Simulated gateways represent independent payment-processing resources, not a requirement to obtain several commercial payment-provider accounts. This one-active-transaction-per-gateway model is the project's stated interpretation of the assignment.
Treat 10 vCPU / 10 GiB as the total allocation until per-system resources are confirmed. No requests-per-second target or latency acceptance threshold has yet been supplied; those must be recorded before formal performance sign-off.

# 3. Scope
Included: identity/login or seeded test accounts; concert details; durable FIFO queue; fixed gateways; dispatch; temporary reservations; simulated payments; atomic confirmation/release; idempotency; recovery; status UI; monitoring; load testing and correctness evaluation.
Excluded from baseline: fan-club priority, random allocation, multi-seat selection, resale, dynamic pricing, Kafka, RabbitMQ, production payment integration and multi-region deployment. Redis caching is optional, not a correctness dependency.
The HLD defines logical components. They may share one backend codebase rather than becoming separate microservices.

# 4. Architecture
```text
Customers / external load generator
                  |
                  v
       Reverse proxy / load balancer
                  |
          +-------+-------+
          |               |
      Backend API 1   Backend API 2
          |               |
          +-------+-------+
                  |
           PostgreSQL
    queue / seats / gateway ledger /
    assignments / payments / bookings
                  ^
                  |
       Dispatcher + recovery worker
                  |
       Fixed payment gateway simulators
       Gateway 1 | Gateway 2 | Gateway 3
                  |
          Verified payment results
                  |
         Booking result handler
                  |
              PostgreSQL

Optional shared Redis: metadata/status cache and rate limits
Dashboard/logs: API, queue, gateways, database and test metrics
```
Backend replicas are stateless for booking ownership. All use the same authoritative database. The dispatcher and result handler operate on shared durable records; additional replicas cannot maintain separate seat inventories or independent copies of gateway availability.
Payment simulation runs outside database transactions. No client can directly select a gateway or bypass the queue.

# 5. Component responsibilities
Frontend: event page, Book Ticket action, queue status, processing result and booking history. It reuses the existing entry after refresh and polls with backoff rather than continuously resubmitting bookings.
Load balancer: routes HTTP requests to healthy API replicas and supports application-tier scaling. It does not determine FIFO position; server-side durable registration does.
User/event module: authenticates identity, checks sale status, provides event information and determines trusted ticket price/currency.
Queue manager: registers accepted attempts durably, prevents duplicate active entries and returns stable FIFO identity and status.
Dispatcher: atomically assigns the oldest eligible waiting entry, an available seat and a free gateway, then starts the payment attempt after commit.
Payment simulator: processes an assigned attempt with configured service duration and outcome; stores repeatable results and supports status lookup and authoritative cancellation.
Result handler: validates payment result and updates reservation, seat, booking, queue entry and gateway in one transaction.
Recovery worker: detects stalled assignments, reconciles simulator outcomes and refills free gateways if a notification was missed.
Dashboard: displays queue length, occupied gateways, inventory states, completion counts, latency and resource metrics.

# 6. End-to-end booking flow
1. User submits a booking request to any backend replica.
2. API validates identity/event and creates or retrieves a durable queue entry using the request's idempotency key. It returns the entry ID and WAITING state promptly.
3. The HTTP request ends; the user does not hold the connection open through the queue and payment lifecycle.
4. Dispatcher finds a free gateway, the next FIFO user and an available seat.
5. One short database transaction creates a PENDING reservation, marks its seat HELD, creates an assignment/payment attempt, marks the entry PROCESSING and marks the gateway BUSY.
6. After commit, start simulated payment using a stable attempt ID and idempotency key.
7. On verified success, one transaction records successful payment, confirms reservation/booking, marks seat SOLD, marks entry CONFIRMED and frees the gateway.
8. On verified terminal failure, one transaction records failure, releases only that reservation's held seat, marks entry FAILED and frees the gateway. No confirmed booking is created.
9. After terminal commit, notify dispatcher to move the next waiting user to the free gateway. A periodic scan recovers missed notifications.
10. Customers retrieve status and confirmed booking details through authenticated APIs.

# 7. FIFO queue and gateway scheduling
Every accepted booking attempt first enters the logical queue, even if dispatch happens immediately. Server-assigned sequence determines FIFO order. Client timestamps and load-balancer arrival order are not authoritative.
Use a per-event control row to coordinate queue sequence allocation and dispatch. Short serialized registration/assignment transactions ensure a later committed request cannot bypass an earlier registered entry. This control row is a deliberate simplicity trade-off and a possible bottleneck to measure.
For each free gateway, select the oldest WAITING entry and an AVAILABLE seat. Create the complete assignment atomically. Recheck all conditions inside the transaction. If anything fails, roll back the whole assignment.
One active assignment per gateway is enforced through the gateway ledger and locking, not merely a process-local semaphore. Use one active dispatcher initially; extra dispatcher processes must coordinate through the same database.
FIFO guarantees assignment order, not payment-completion order. A later user assigned to another gateway may finish first.
The configured payment count remains fixed within a run. Busy and reconciling transactions consume that capacity. Additional API replicas do not increase it.

# 8. Seat, queue and payment states
```text
Queue: WAITING -> PROCESSING -> CONFIRMED or FAILED
                         -> RECONCILING -> terminal result
       WAITING -> SOLD_OUT when inventory is definitively exhausted

Seat: AVAILABLE -> HELD -> SOLD on successful payment
                        -> AVAILABLE on terminal failure/cancellation

Gateway: FREE -> BUSY -> FREE
                     -> RECONCILING -> FREE after resolution

Reservation: PENDING -> CONFIRMED or FAILED/CANCELLED
```
HELD is temporary exclusive ownership, not ticket confirmation. If all seats are HELD but some payments may fail, users remain queued. Stop dispatch and mark remaining entries SOLD_OUT only when no further inventory can become available under the sale policy.
A terminal failed attempt leaves the queue. Automatic retries are not the baseline; a permitted new attempt joins the tail rather than jumping ahead.

# 9. Data model
users: user_id, name, email_unique, password_hash or seeded identity.
events: event_id, title, venue, event_time, total_seats, price_minor, currency, sale_status.
event_control: event_id, next_queue_sequence, dispatch_paused.
queue_entries: entry_id, event_id, user_id, attempt_number, queue_sequence, status, joined_at, assigned_at, completed_at. Unique(event_id, queue_sequence); prevent more than one active entry per user/event.
payment_gateways: gateway_id, event_id, status, current_assignment_id, generation, updated_at. Pre-create the fixed gateway count.
assignments: assignment_id, entry_id_unique, gateway_id, gateway_generation, reservation_id, state, started_at, deadline, completed_at.
seats: seat_id, event_id, label, status, current_reservation_id, version. Unique(event_id, label).
reservations: reservation_id, event_id, user_id, seat_id, status, created_at, deadline.
payments: payment_id, assignment_id_unique, provider_reference_unique, idempotency_key_unique, amount_minor, currency, status, sampled_duration, sampled_outcome, completed_at.
bookings: booking_id, reservation_id_unique, seat_id_unique, user_id, payment_id_unique, confirmed_at.
callback_receipts: provider_event_id_unique, payment_id, received_at, processing_status.
idempotency_records: user_id, operation, request_key, request_hash, result_reference; unique(user_id, operation, request_key).
Store amount as integer minor units with currency. Index queue by event/status/sequence, seats by event/status, and unresolved assignments by deadline. Confirmed-seat uniqueness assumes this initial no-resale model.

# 10. Transaction consistency and duplicate prevention
PostgreSQL is authoritative for queue order, gateway ownership and seat ownership. Assignment is a short atomic transaction; payment occurs after commit; confirmation/release uses another short atomic transaction. Database row locks do not stay open while payment runs. [web:92]
All transition handlers follow a common lock order: event-control row, gateway, queue/assignment and reservation/seat. Recheck state and ownership under lock. Keep transactions short and measure lock waits.
A held seat records its reservation owner. Cleanup and callbacks change it only when that owner still matches. Old events cannot release or sell a newer owner's seat.
Unique booking-seat and payment-reference constraints supplement transaction checks. Repeating the same request returns its existing logical result; reusing an idempotency key with a different body returns a conflict. Repeated callbacks do not create another confirmation.
Process restart after uncertain commit is resolved by querying stable request/assignment identifiers, not blindly creating replacement attempts.

# 11. Payment simulation and recovery
Use a simulator with start, status and cancel operations. Configure outcome probabilities, processing-time distribution, callback delay and duplicate delivery. Record random seed and sampled attempt result so restarts do not reroll outcomes.
An HTTP timeout is an unknown outcome, not proof of failure. Retain the assignment, seat and gateway under reconciliation until the simulator reports a terminal outcome. Simulator cancellation must atomically win or lose against success; it cannot authorize both.
A stalled assignment deadline triggers reconciliation, not unconditional release. Callback and recovery handlers use the same locks and state transitions.
On restart, inspect durable BUSY/RECONCILING gateways and recover their existing attempts before reuse. If the database is unavailable, pause dispatch/confirmation and resume through reconciliation. Never infer a sale from frontend or cache state.
If a real provider is later added, signature validation, provider-specific cancellation and late-success compensation require a separate integration design; the baseline uses no real card data or money.

# 12. APIs and user-facing responses
GET /events/{id}: concert details and sale state.
POST /events/{id}/queue: authenticated join; Idempotency-Key required.
GET /events/{id}/queue/me: own queue/assignment status.
GET /assignments/{id}: own payment-processing state.
POST /payments/callback: simulator-authenticated result, not a user-supplied success flag.
GET /me/bookings and GET /bookings/{id}: confirmed bookings owned by the user.
GET /admin/dashboard: operational metrics and gateway state.
POST /admin/simulation/start: initialize fixed gateway count and workload settings.
POST /admin/dispatch/pause: pause new assignment without discarding entries.
Use stable error codes, request IDs and appropriate HTTP responses. Queue acceptance is distinct from booking confirmation. SOLD_OUT is an expected business outcome, not automatically an infrastructure error. Restrict administration and all user-specific reads by authorization.

# 13. Deployment and scaling
Proposed stack: React/Next.js frontend, NestJS backend, PostgreSQL, local payment simulator, optional Redis, Docker Compose or equivalent supervised processes, and k6/Locust for testing.
Start with one API instance to establish a baseline. Add replicas behind the load balancer on allotted systems. Keep common durable state and configuration; basic REST traffic requires no sticky sessions.
Use the actual shared 10 vCPU / 10 GiB budget until per-system allocation is confirmed. Leave memory headroom for operating system, page cache and runtime overhead. Keep aggregate database pools bounded across replicas; 500 HTTP requests must not automatically allocate 500 database connections.
Persistent volumes and tested restart recovery are necessary. Multiple application hosts do not make a single PostgreSQL instance highly available. Record storage/network limitations and actual host resources.
Redis, if enabled, stores advisory metadata/status cache and rate limits. It never owns the only queue copy or confirms bookings. Fail cache reads gracefully without overwhelming PostgreSQL.
Scale API replicas only when API capacity is limiting. Fixed payment processing, database I/O and the event-control lock may remain bottlenecks. Measure before introducing more complexity.

# 14. Load-testing interpretation and method
The required mixed-traffic run sends 100,000 total HTTP requests with a maximum of 500 requests in flight. Each load-generator client waits for its current response before sending another request. Maintain approximately 500 during steady state; startup and final drain naturally have fewer.
Declare the endpoint mix before testing. For example, use 30% event reads, 30% queue joins, 30% queue-status reads and 10% booking-status reads, with valid seeded accounts and state-aware scripts. This is an example test mix, not a supplied requirement. Every HTTP operation counts toward the cumulative total; expected business conflicts and sold-out outcomes are labelled separately.
A separate queue-ingestion experiment may send 100,000 unique booking submissions, but its additional status traffic must be counted separately. Do not describe the mixed 100,000-request run as 100,000 users.
Record attempted, completed, failed and retried HTTP requests; distinguish logical operations from extra retry attempts. Prefer an external generator and measure generator utilization so its own limits are not mistaken for server limits.
Ending HTTP submission does not mean queued payments have finished. Continue observation to drain/sellout, or report the queue, active assignments and unresolved payments remaining at a documented cutoff.

# 15. Evaluation metrics and acceptance
Performance: endpoint p50/p95/p99 latency, HTTP throughput, error rate, queue waiting time, successful booking throughput, payment duration, gateway utilization and refill delay.
Resources: CPU/RAM per host, database connection/pool wait, transaction/lock time, disk I/O and optional Redis usage.
Correctness: no duplicate confirmed seat; every confirmation has matching successful payment; unresolved active payments never exceed fixed gateway capacity; no lost accepted entry; seat counts reconcile as AVAILABLE + HELD + SOLD; no orphan gateway assignment.
Fairness: FIFO assignment sequence among eligible entries, not payment-completion sequence.
Acceptance requires a recorded 500-concurrency/100,000-total-request run, agreed latency/error thresholds and zero correctness violations. Until measured, these are design targets rather than proven capacity.

# 16. Test scenarios
- Basic success and failure with a small seat inventory and three gateways.
- Concurrent duplicate joins and requests through different API replicas.
- Many users competing near the last available seat.
- Duplicate payment callback and callback/recovery race.
- Slow payment, lost callback and terminal simulator cancellation.
- Crash after assignment commit and before provider start.
- Crash after simulator success and before confirmation commit.
- Restart one API or dispatcher while traffic continues.
- Fixed gateway-count comparisons across separate runs.
- One-versus-two API replicas under the same resource budget; separately label experiments that add hardware.
Keep gateway configuration, simulator seed and arrival profile comparable. Save traces with entry, gateway, assignment, seat and payment IDs, without logging credentials.

# 17. Implementation and final demonstration
Build in order: schema/seed data and identity; durable FIFO registration; fixed gateways and dispatcher; temporary reservations and simulator; atomic completion/refill; idempotency/recovery; multi-replica deployment; load testing and monitoring.
Demonstrate queued users with three visible gateways, successful and failed transactions, next-user refill, duplicate callback handling and restart recovery. Present measured request and booking metrics separately.
Deliver source/setup instructions, HLD, database migrations, API specification, simulator settings, automated correctness tests, load scripts, traces and a benchmark report including limitations.
This document is the consolidated baseline for the assigned sub-theme and supersedes the earlier broader feature plans.
