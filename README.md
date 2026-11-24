# Concert Ticket Booking System - Virtual Queue & Fixed Payment Gateways

Production-grade implementation of the High-Level Design (HLD) specified in `Concert_Booking_Clean_HLD.md` (**Sub-theme 1: Virtual Queue-Based Booking**).

---

## 1. System Architecture

```text
                        [ Clients / 500-Concurrency Load Generator ]
                                             |
                                             v
                      [ Nginx Load Balancer / Reverse Proxy (Port 80) ]
                                             |
          +----------------------------------+----------------------------------+
          |                                  |                                  |
          v                                  v                                  v
    [ Backend Node 1 ]                 [ Backend Node 2 ]               [ Backend Remote SSH Node ]
      (Port 4001)                        (Port 4002)                        (Port 4001, 4002...)
          |                                  |                                  |
          +----------------------------------+----------------------------------+
                                             |
                                             v
                          [ Authoritative Central PostgreSQL ]
                   event_control | queue_entries | seats | payment_gateways
                                             |
                              [ Dispatcher + Recovery Worker ]
                                             |
                             [ Fixed Payment Gateways (1..N) ]
                             Gateway 1 | Gateway 2 | Gateway 3
                                             |
                                   [ Result Handler ]
                              Atomic Confirmation / Release
```

### Core Design Guarantees (HLD Section 2, 7, 10):
1. **Strict FIFO Virtual Queue**: Every booking attempt enters a durable logical queue. The monotonic `next_queue_sequence` on `event_control` establishes authoritative FIFO ordering across all replicas.
2. **Fixed Payment Gateway Capacity**: The configured gateway count (e.g., 3 gateways) is enforced cluster-wide via the database ledger. Additional API replicas increase HTTP ingestion capacity without exceeding fixed payment processing limits.
3. **Atomic Consistency & Zero Duplicates**:
   - Short atomic assignment: Locks `event_control` -> next FREE `payment_gateway` -> oldest WAITING `queue_entry` -> next AVAILABLE `seat` -> creates PENDING `reservation` and marks seat HELD.
   - Database row locks are held for < 2 milliseconds and **never held open during payment execution**.
   - Verified payment confirmation: Only upon verified successful payment is the seat marked SOLD, booking confirmed, and gateway freed.
4. **Simulator & Recovery**:
   - Out-of-band payment simulation with deterministic outcomes and HMAC signature verification.
   - Background recovery worker reconciles stalled assignments past deadline, frees orphaned gateways, and triggers next-user refills.

---

## 2. Directory Structure

```
project/
├── Concert_Booking_Clean_HLD.md  # Original HLD specification
├── backend/                      # High-throughput Fastify/TypeScript backend
│   ├── src/
│   │   ├── config.ts             # Configuration, ports, timeouts, simulator settings
│   │   ├── db/
│   │   │   ├── schema.sql        # Authoritative DDL (Section 9)
│   │   │   ├── connection.ts     # PostgreSQL connection pool with embedded PGlite fallback
│   │   │   └── migrator.ts       # Auto-migrations and seed data generator
│   │   ├── services/
│   │   │   ├── queue.service.ts      # Durable FIFO queue, idempotency, status lookups
│   │   │   ├── dispatcher.service.ts # Atomic 4-step lock scheduling & payment kickoff
│   │   │   ├── payment-simulator.ts  # Fixed gateways, latency, deterministic outcomes
│   │   │   ├── result-handler.ts     # Atomic seat confirmation/release & capacity refill
│   │   │   └── recovery.worker.ts    # Stalled assignment reconciliation & orphan recovery
│   │   ├── routes/
│   │   │   └── api.routes.ts         # REST API endpoints (Section 12) + Dashboard UI
│   │   ├── server.ts             # Fastify server initialization & dependency wiring
│   │   └── index.ts              # Process entrypoint
│   ├── tests/
│   │   └── correctness.test.ts   # 5/5 Automated invariant & correctness test suite
│   ├── package.json
│   ├── tsconfig.json
│   └── Dockerfile
├── frontend/
│   └── index.html                # Interactive Ticket Booking UI & Real-Time Gateway Monitor
├── deploy/                       # Multi-node scaling across remote SSH systems
│   ├── inventory.json            # SSH hosts inventory (central server & worker nodes)
│   ├── cluster_manager.py        # Automated SSH cluster deployment & orchestration CLI
│   ├── deploy_worker.sh          # Standalone shell script for launching remote replicas
│   └── README_SSH_SCALING.md     # Detailed step-by-step SSH cluster scaling guide
├── loadtest/
│   ├── load_test.py              # 500-concurrency async HTTP load generator (30/30/30/10 mix)
│   └── k6_script.js              # k6 benchmark script
├── nginx/
│   ├── nginx.conf                # High-performance reverse proxy & load balancer
│   └── nginx.conf.template       # Dynamic upstream template for SSH workers
├── docker-compose.yml            # Multi-replica Docker Compose setup
└── README.md
```

---

## 3. Quick Start (Local Run)

### Prerequisites
- Node.js >= 20
- Python 3.10+ (for load testing & cluster manager)

### 1. Build & Run the Backend
```bash
cd backend
npm install
npm run build
npm start
```
The server will start at `http://localhost:4000`. If `DATABASE_URL` is not specified, it automatically starts in embedded WASM PostgreSQL mode (PGlite) with all 20,000 seats, 3 fixed gateways, and seed accounts pre-loaded!

### 2. Open the Interactive Web Dashboard
Open your browser to:
```
http://localhost:4000/
```
From here you can:
- Enter a user ID and click **"Join Queue & Book Ticket"**.
- Watch your position advance in real-time as gateways process transactions.
- Inspect the **Fixed Payment Gateways Monitor** showing live occupancy, generations, and seat assignments.
- Test controls: **Pause Dispatch**, **Simulate Queued Users**, or **Reset Demo**.

---

## 4. Scaling Across Remote SSH Systems

The backend replicas are completely stateless regarding booking ownership. All coordination happens through the central PostgreSQL database.

### Architecture for SSH Scaling:
- **Central Host**: Runs PostgreSQL on port `5432` and Nginx on port `80`.
- **Worker Hosts (Remote SSH Systems)**: Run 1 or more backend replicas on ports `4001, 4002...` connected to the central PostgreSQL database.

### Automated SSH Cluster Deployment Tool (`deploy/cluster_manager.py`)

#### Step 1: Configure `deploy/inventory.json`
Specify your central database host and the list of remote SSH machines:
```json
{
  "central_server": {
    "host": "192.168.1.100",
    "postgres_host": "192.168.1.100",
    "postgres_port": 5432,
    "postgres_db": "concert_booking",
    "postgres_user": "postgres",
    "postgres_password": "your_db_password"
  },
  "remote_nodes": [
    {
      "name": "worker-1",
      "host": "192.168.1.101",
      "ssh_port": 22,
      "ssh_user": "ubuntu",
      "ssh_key_path": "~/.ssh/id_rsa",
      "remote_dir": "/opt/concert-booking",
      "backend_ports": [4001, 4002]
    },
    {
      "name": "worker-2",
      "host": "192.168.1.102",
      "ssh_port": 22,
      "ssh_user": "ubuntu",
      "ssh_key_path": "~/.ssh/id_rsa",
      "remote_dir": "/opt/concert-booking",
      "backend_ports": [4001, 4002]
    }
  ]
}
```

#### Step 2: Test SSH Connectivity
```bash
python3 deploy/cluster_manager.py test
```

#### Step 3: Sync Code & Build on All Remote Nodes
```bash
python3 deploy/cluster_manager.py deploy
```

#### Step 4: Launch Replicas & Auto-Configure Nginx
```bash
python3 deploy/cluster_manager.py start
```
This automatically starts backend workers on each SSH node, passes `DATABASE_URL`, regenerates `nginx/nginx.conf` with all remote hosts in the upstream pool, and ensures load balancing.

#### Step 5: Check Cluster Health Across All SSH Systems
```bash
python3 deploy/cluster_manager.py status
```

#### Step 6: Stop Cluster
```bash
python3 deploy/cluster_manager.py stop
```

---

## 5. Automated Verification & Correctness Tests

Run the automated verification suite:
```bash
cd backend
npm test
```

### Verified Test Cases:
- **TEST 1: Strict FIFO Queue Sequencing & Idempotency**:
  Verifies that queue sequence increments monotonically, arrival order is strictly maintained, and re-submitting with the same idempotency key returns the cached logical position.
- **TEST 2: Fixed Payment Gateway Concurrency Cap**:
  Confirms that active gateway transactions never exceed the fixed capacity (3 gateways).
- **TEST 3: Drain Queue to Completion & Invariant Checks**:
  - Zero duplicate seat allocations across all completed bookings.
  - Every confirmed booking has an exact corresponding SUCCESS payment.
  - Inventory balance reconciles: `AVAILABLE + HELD + SOLD = total_seats`.
- **TEST 4: Payment Failure & Automatic Seat Release**:
  Verifies that failed/declined transactions transition entry to `FAILED`, release the held seat back to `AVAILABLE`, and free the gateway.
- **TEST 5: Recovery Worker & Stalled Assignment Reconciliation**:
  Tests automatic reconciliation of expired assignments past deadline, simulator cancellation, gateway freeing, and subsequent queue refills.

---

## 6. High-Concurrency Load Testing

Run the included high-concurrency async load test client:
```bash
# 500 concurrent in-flight HTTP requests, 100,000 requests, mixed workload
python3 loadtest/load_test.py --url http://localhost:4000 -c 500 -n 100000
```

### Workload Mix (per HLD Section 14):
- 30% Event reads (`GET /events/{id}`)
- 30% Queue joins (`POST /events/{id}/queue`)
- 30% Queue status reads (`GET /events/{id}/queue/me`)
- 10% Booking reads (`GET /me/bookings`)

Or using k6:
```bash
k6 run -e TARGET_URL=http://localhost:80 loadtest/k6_script.js
```
