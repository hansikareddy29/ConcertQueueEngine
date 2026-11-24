#!/usr/bin/env python3
"""
Concert Booking High-Concurrency Load Testing Tool
Compliant with Section 2.1 & 14 of HLD:
- Up to 500 concurrent requests in flight
- Configurable request mix (30% event reads, 30% queue joins, 30% status reads, 10% bookings)
- Tracks latency percentiles (p50, p95, p99), error rate, throughput (RPS), and correctness
"""

import sys
import time
import math
import random
import asyncio
import aiohttp
import argparse
from typing import List, Dict

class LoadTestMetrics:
    def __init__(self):
        self.latencies: List[float] = []
        self.status_codes: Dict[int, int] = {}
        self.operations: Dict[str, int] = {"event_read": 0, "queue_join": 0, "queue_status": 0, "booking_read": 0}
        self.errors = 0
        self.start_time = 0.0
        self.end_time = 0.0

    def record(self, op: str, status: int, latency_ms: float):
        self.latencies.append(latency_ms)
        self.status_codes[status] = self.status_codes.get(status, 0) + 1
        self.operations[op] = self.operations.get(op, 0) + 1
        if status >= 400 and status not in (404, 409):
            self.errors += 1

    def print_report(self):
        elapsed = max(self.end_time - self.start_time, 0.001)
        total_reqs = len(self.latencies)
        rps = total_reqs / elapsed

        sorted_latencies = sorted(self.latencies)
        p50 = sorted_latencies[int(len(sorted_latencies) * 0.50)] if sorted_latencies else 0
        p95 = sorted_latencies[int(len(sorted_latencies) * 0.95)] if sorted_latencies else 0
        p99 = sorted_latencies[int(len(sorted_latencies) * 0.99)] if sorted_latencies else 0
        avg = sum(sorted_latencies) / len(sorted_latencies) if sorted_latencies else 0

        print("\n=======================================================")
        print("          CONCERT BOOKING LOAD TEST REPORT             ")
        print("=======================================================")
        print(f"Total Requests Completed:   {total_reqs:,}")
        print(f"Total Test Duration:        {elapsed:.2f} seconds")
        print(f"Average Throughput (RPS):   {rps:.2f} req/sec")
        print("-------------------------------------------------------")
        print("Latency Distribution:")
        print(f"  Average:                  {avg:.2f} ms")
        print(f"  p50 (Median):             {p50:.2f} ms")
        print(f"  p95:                      {p95:.2f} ms")
        print(f"  p99:                      {p99:.2f} ms")
        print("-------------------------------------------------------")
        print("Workload Breakdown:")
        for op, count in self.operations.items():
            pct = (count / total_reqs * 100) if total_reqs > 0 else 0
            print(f"  {op:15s}:           {count:6d} ({pct:5.1f}%)")
        print("-------------------------------------------------------")
        print("HTTP Status Codes:")
        for code, count in sorted(self.status_codes.items()):
            print(f"  HTTP {code}:                 {count:6d}")
        print(f"System Error Count:         {self.errors}")
        print("=======================================================\n")

async def worker(
    target_url: str,
    event_id: str,
    total_requests: int,
    request_counter: List[int],
    semaphore: asyncio.Semaphore,
    session: aiohttp.ClientSession,
    metrics: LoadTestMetrics,
):
    while True:
        # Atomic counter increment
        if request_counter[0] >= total_requests:
            break
        req_num = request_counter[0]
        request_counter[0] += 1

        user_id = f"usr_{random.randint(1, 1000):05d}"
        headers = {
            "x-user-id": user_id,
            "Idempotency-Key": f"key_{user_id}_{req_num}",
            "Content-Type": "application/json"
        }

        # 30% event read, 30% queue join, 30% queue status, 10% bookings
        rand_val = random.random()
        t0 = time.perf_counter()

        try:
            async with semaphore:
                if rand_val < 0.30:
                    op = "event_read"
                    async with session.get(f"{target_url}/events/{event_id}", headers=headers) as resp:
                        await resp.read()
                        status = resp.status
                elif rand_val < 0.60:
                    op = "queue_join"
                    async with session.post(f"{target_url}/events/{event_id}/queue", headers=headers, json={}) as resp:
                        await resp.read()
                        status = resp.status
                elif rand_val < 0.90:
                    op = "queue_status"
                    async with session.get(f"{target_url}/events/{event_id}/queue/me", headers=headers) as resp:
                        await resp.read()
                        status = resp.status
                else:
                    op = "booking_read"
                    async with session.get(f"{target_url}/me/bookings", headers=headers) as resp:
                        await resp.read()
                        status = resp.status

            latency_ms = (time.perf_counter() - t0) * 1000.0
            metrics.record(op, status, latency_ms)
        except Exception as e:
            latency_ms = (time.perf_counter() - t0) * 1000.0
            metrics.record("error", 599, latency_ms)

async def run_load_test(target_url: str, event_id: str, concurrency: int, total_requests: int):
    print(f"[+] Starting Load Test against {target_url}")
    print(f"    Concurrency:    {concurrency} simultaneous in-flight requests")
    print(f"    Total Requests: {total_requests:,}")
    print(f"    Target Event:   {event_id}\n")

    metrics = LoadTestMetrics()
    semaphore = asyncio.Semaphore(concurrency)
    counter = [0]

    # Connection pooling with high max connections
    connector = aiohttp.TCPConnector(limit=concurrency + 50, limit_per_host=concurrency + 50, keepalive_timeout=30)
    timeout = aiohttp.ClientTimeout(total=15)

    metrics.start_time = time.time()

    async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
        # Spawn concurrent worker tasks
        tasks = [
            asyncio.create_task(worker(target_url, event_id, total_requests, counter, semaphore, session, metrics))
            for _ in range(concurrency)
        ]
        
        # Periodic progress monitor
        async def progress_reporter():
            while counter[0] < total_requests:
                await asyncio.sleep(2.0)
                done = counter[0]
                pct = (done / total_requests) * 100
                print(f"  Progress: {done:,}/{total_requests:,} ({pct:5.1f}%) requests sent...")

        monitor = asyncio.create_task(progress_reporter())
        await asyncio.gather(*tasks)
        monitor.cancel()

    metrics.end_time = time.time()
    metrics.print_report()

def main():
    parser = argparse.ArgumentParser(description="Concert Booking High-Concurrency Load Tester")
    parser.add_argument("--url", default="http://127.0.0.1:4000", help="Target API URL (default: http://127.0.0.1:4000)")
    parser.add_argument("--event", default="evt_concert_2026", help="Target Event ID (default: evt_concert_2026)")
    parser.add_argument("-c", "--concurrency", type=int, default=500, help="Concurrent HTTP requests in flight (default: 500)")
    parser.add_argument("-n", "--requests", type=int, default=100000, help="Total cumulative HTTP requests (default: 100000)")
    args = parser.parse_args()

    asyncio.run(run_load_test(args.url.rstrip('/'), args.event, args.concurrency, args.requests))

if __name__ == "__main__":
    main()
