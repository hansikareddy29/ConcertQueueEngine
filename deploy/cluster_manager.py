#!/usr/bin/env python3
"""
Concert Booking System - SSH Cluster Deployment & Orchestrator
Manages multi-node scaling across remote SSH systems per Section 13 of HLD.
"""

import os
import sys
import json
import subprocess
import argparse
from pathlib import Path
from typing import Dict, Any, List

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
CONFIG_PATH = SCRIPT_DIR / "inventory.json"
NGINX_TEMPLATE_PATH = PROJECT_ROOT / "nginx" / "nginx.conf.template"
NGINX_CONF_PATH = PROJECT_ROOT / "nginx" / "nginx.conf"

def load_inventory() -> Dict[str, Any]:
    if not CONFIG_PATH.exists():
        print(f"[-] Inventory file not found at {CONFIG_PATH}")
        sys.exit(1)
    with open(CONFIG_PATH, "r") as f:
        return json.load(f)

def run_ssh_command(node: Dict[str, Any], cmd: str, check: bool = True) -> subprocess.CompletedProcess:
    ssh_cmd = [
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-o", "ConnectTimeout=5",
        "-p", str(node.get("ssh_port", 22)),
    ]
    if "ssh_key_path" in node and node["ssh_key_path"]:
        key_path = os.path.expanduser(node["ssh_key_path"])
        if os.path.exists(key_path):
            ssh_cmd.extend(["-i", key_path])
    
    target = f"{node['ssh_user']}@{node['host']}"
    ssh_cmd.extend([target, cmd])
    
    print(f"[{node['name']}] $ {cmd}")
    res = subprocess.run(ssh_cmd, capture_output=True, text=True)
    if check and res.returncode != 0:
        print(f"[-] Error on {node['name']}: {res.stderr.strip()}")
    return res

def test_connections():
    inv = load_inventory()
    nodes = inv.get("remote_nodes", [])
    print(f"\n[+] Testing SSH connectivity to {len(nodes)} remote nodes...\n")
    success_count = 0
    for node in nodes:
        print(f"[*] Probing {node['name']} ({node['host']})...")
        res = run_ssh_command(node, "echo 'PONG' && uname -a", check=False)
        if res.returncode == 0:
            print(f"    [OK] Connected: {res.stdout.strip()}")
            success_count += 1
        else:
            print(f"    [FAILED] {res.stderr.strip() or 'Connection failed'}")
    print(f"\n[+] Connectivity Summary: {success_count}/{len(nodes)} hosts reachable.\n")

def deploy_code():
    inv = load_inventory()
    nodes = inv.get("remote_nodes", [])
    print(f"\n[+] Syncing backend code to {len(nodes)} remote nodes...\n")
    
    backend_dir = PROJECT_ROOT / "backend"
    for node in nodes:
        rdir = node.get("remote_dir", "/opt/concert-booking")
        print(f"[*] Preparing directory on {node['name']}...")
        run_ssh_command(node, f"mkdir -p {rdir}/backend", check=True)
        
        # Build local rsync command
        rsync_cmd = [
            "rsync", "-avz", "--delete",
            "--exclude", "node_modules",
            "--exclude", ".git",
            "--exclude", "dist",
            "-e", f"ssh -p {node.get('ssh_port', 22)}",
            f"{backend_dir}/",
            f"{node['ssh_user']}@{node['host']}:{rdir}/backend/",
        ]
        print(f"[*] Syncing files to {node['name']}:{rdir}/backend/ ...")
        subprocess.run(rsync_cmd, check=True)
        
        # Run npm install on remote node
        print(f"[*] Installing dependencies on {node['name']}...")
        run_ssh_command(node, f"cd {rdir}/backend && npm install --production=false && npm run build", check=True)
        print(f"[OK] {node['name']} ready.\n")

def start_cluster():
    inv = load_inventory()
    central = inv.get("central_server", {})
    pg_host = central.get("postgres_host", "127.0.0.1")
    pg_port = central.get("postgres_port", 5432)
    pg_db = central.get("postgres_db", "concert_booking")
    pg_user = central.get("postgres_user", "postgres")
    pg_pass = central.get("postgres_password", "")
    
    db_url = f"postgresql://{pg_user}:{pg_pass}@{pg_host}:{pg_port}/{pg_db}"
    nodes = inv.get("remote_nodes", [])
    
    print(f"\n[+] Starting backend replicas across {len(nodes)} nodes with DB {pg_host}:{pg_port}/{pg_db} ...\n")
    
    for node in nodes:
        rdir = node.get("remote_dir", "/opt/concert-booking")
        ports = node.get("backend_ports", [4000])
        for port in ports:
            node_id = f"{node['name']}_port_{port}"
            print(f"[*] Launching instance {node_id} on {node['host']}:{port}...")
            # Start process via nohup or pm2
            start_cmd = (
                f"cd {rdir}/backend && "
                f"PORT={port} "
                f"DATABASE_URL='{db_url}' "
                f"NODE_ID='{node_id}' "
                f"nohup node dist/index.js > app_{port}.log 2>&1 &"
            )
            run_ssh_command(node, start_cmd, check=False)
            print(f"    [OK] Started {node_id}")
    
    # Update nginx upstream configuration
    update_nginx_config()
    print("\n[+] Cluster startup complete.\n")

def stop_cluster():
    inv = load_inventory()
    nodes = inv.get("remote_nodes", [])
    print(f"\n[+] Stopping remote backend instances on {len(nodes)} nodes...\n")
    for node in nodes:
        print(f"[*] Stopping node processes on {node['name']}...")
        run_ssh_command(node, "pkill -f 'node dist/index.js' || true", check=False)
    print("\n[+] Cluster stopped.\n")

def cluster_status():
    inv = load_inventory()
    nodes = inv.get("remote_nodes", [])
    print(f"\n[+] Cluster Node Status ({len(nodes)} configured hosts):\n")
    for node in nodes:
        ports = node.get("backend_ports", [4000])
        print(f"--- Node: {node['name']} ({node['host']}) ---")
        res = run_ssh_command(node, "pgrep -a -f 'node dist/index.js' || echo 'None running'", check=False)
        print(res.stdout.strip())
        for port in ports:
            curl_res = run_ssh_command(node, f"curl -s http://127.0.0.1:{port}/health || echo 'UNREACHABLE'", check=False)
            print(f"    Port {port} Health: {curl_res.stdout.strip()}")
        print()

def update_nginx_config():
    inv = load_inventory()
    nodes = inv.get("remote_nodes", [])
    
    upstream_servers: List[str] = []
    for node in nodes:
        for port in node.get("backend_ports", [4000]):
            upstream_servers.append(f"    server {node['host']}:{port} max_fails=3 fail_timeout=10s;")
            
    # Also add local server if configured
    central = inv.get("central_server", {})
    if central.get("host") in ("127.0.0.1", "localhost"):
        upstream_servers.append("    server 127.0.0.1:4000 max_fails=3 fail_timeout=10s;")

    upstreams_block = "\n".join(upstream_servers)

    nginx_conf = f"""# Auto-generated Nginx Load Balancer for Concert Booking Cluster
events {{
    worker_connections 2048;
    use epoll;
    multi_accept on;
}}

http {{
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

    sendfile        on;
    tcp_nopush     on;
    tcp_nodelay    on;
    keepalive_timeout 65;
    keepalive_requests 10000;

    upstream backend_cluster {{
        least_conn;
{upstreams_block}
        keepalive 64;
    }}

    server {{
        listen 80;
        server_name _;

        location / {{
            proxy_pass http://backend_cluster;
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_next_upstream error timeout http_502 http_503;
        }}

        location /health {{
            proxy_pass http://backend_cluster/health;
        }}
    }}
}}
"""
    with open(NGINX_CONF_PATH, "w") as f:
        f.write(nginx_conf)
    print(f"[+] Generated Nginx load balancer configuration at {NGINX_CONF_PATH} with {len(upstream_servers)} upstream servers.")

def main():
    parser = argparse.ArgumentParser(description="Concert Booking SSH Cluster Manager")
    parser.add_argument("command", choices=["test", "deploy", "start", "stop", "status", "nginx"],
                        help="Action to perform: test (probe SSH), deploy (sync code), start, stop, status, nginx")
    args = parser.parse_args()

    if args.command == "test":
        test_connections()
    elif args.command == "deploy":
        deploy_code()
    elif args.command == "start":
        start_cluster()
    elif args.command == "stop":
        stop_cluster()
    elif args.command == "status":
        cluster_status()
    elif args.command == "nginx":
        update_nginx_config()

if __name__ == "__main__":
    main()
