# Scaling Concert Booking System across SSH Systems

This guide explains how to scale the Concert Booking Backend across multiple SSH machines per **Section 4, 13, and 16** of the High-Level Design (HLD).

---

## 1. Cluster Architecture Overview

```
                        [ Clients / Load Generator ]
                                     |
                                     v
                 [ Central Server: Nginx Load Balancer (Port 80) ]
                                     |
         +---------------------------+---------------------------+
         |                           |                           |
         v                           v                           v
  [ SSH Node 1 ]              [ SSH Node 2 ]              [ Central Host ]
 Backend :4001, :4002        Backend :4001, :4002        Backend :4000
         |                           |                           |
         +---------------------------+---------------------------+
                                     |
                                     v
             [ Central Server: PostgreSQL Database (Port 5432) ]
              Authoritative FIFO Queue, Row Locks, Ledger, State
```

### Why this design scales cleanly:
- **Stateless Application Replicas**: The backend nodes do not maintain in-memory booking ownership.
- **Authoritative Central PostgreSQL**: Coordinates monotonic sequence generation (`event_control`), atomic dispatch, seat holding, and payment confirmation.
- **Fixed Payment Capacity**: The configured number of payment gateways (e.g. 3) is enforced cluster-wide through the database ledger, regardless of how many SSH replicas you run.
- **High Concurrency**: Supports 500+ simultaneous in-flight connections spread across all your SSH instances.

---

## 2. Prerequisites & Setup

### Step A: Configure Central PostgreSQL
On your central machine hosting PostgreSQL, ensure PostgreSQL allows incoming connections from your worker SSH hosts:
1. Edit `/etc/postgresql/16/main/postgresql.conf`:
   ```
   listen_addresses = '*'
   ```
2. Edit `/etc/postgresql/16/main/pg_hba.conf` to allow worker subnets:
   ```
   host    concert_booking    postgres    192.168.1.0/24    scram-sha-256
   ```
3. Restart PostgreSQL:
   ```bash
   sudo systemctl restart postgresql
   ```

### Step B: Set Up SSH Keys
Ensure the machine running `cluster_manager.py` can connect to all remote systems without password prompts:
```bash
ssh-copy-id ubuntu@node1-ip
ssh-copy-id ubuntu@node2-ip
```

---

## 3. Configuring the Inventory

Edit `deploy/inventory.json` with your real server IPs, SSH users, and ports:
```json
{
  "central_server": {
    "host": "192.168.1.100",
    "postgres_host": "192.168.1.100",
    "postgres_port": 5432,
    "postgres_db": "concert_booking",
    "postgres_user": "postgres",
    "postgres_password": "your_secure_password"
  },
  "remote_nodes": [
    {
      "name": "worker-alpha",
      "host": "192.168.1.101",
      "ssh_port": 22,
      "ssh_user": "ubuntu",
      "ssh_key_path": "~/.ssh/id_rsa",
      "remote_dir": "/opt/concert-booking",
      "backend_ports": [4001, 4002]
    },
    {
      "name": "worker-beta",
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

---

## 4. Cluster Management Commands

Use `deploy/cluster_manager.py` to automate all tasks across your SSH fleet:

### 1. Test SSH Connectivity
```bash
python3 deploy/cluster_manager.py test
```
Verifies SSH connection, keys, and operating system info on each node.

### 2. Deploy Code & Install Dependencies
```bash
python3 deploy/cluster_manager.py deploy
```
Syncs backend source files to all remote hosts using `rsync` over SSH, builds TypeScript, and installs production dependencies.

### 3. Launch Backend Replicas
```bash
python3 deploy/cluster_manager.py start
```
Starts backend instances across all remote SSH nodes, passing the central `DATABASE_URL` and unique `NODE_ID`s. Automatically regenerates `nginx/nginx.conf` with all upstream nodes.

### 4. Check Cluster Health
```bash
python3 deploy/cluster_manager.py status
```
Queries process status and `/health` endpoints across all machines.

### 5. Stop Cluster
```bash
python3 deploy/cluster_manager.py stop
```
Safely terminates backend worker processes on all remote nodes.

---

## 5. Standalone Manual Worker Startup
If you want to manually run an instance directly on an SSH host:
```bash
cd /opt/concert-booking/backend
export DATABASE_URL="postgresql://postgres:password123@192.168.1.100:5432/concert_booking"
export PORT=4001
export NODE_ID="manual_worker_1"
node dist/index.js
```
