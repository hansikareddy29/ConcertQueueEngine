import http from 'k6/http';
import { check, sleep } from 'k6';

// k6 Load Test Configuration per HLD Section 2.1 & 14
// 500 concurrent virtual users in-flight, cumulative target requests
export const options = {
  scenarios: {
    mixed_traffic: {
      executor: 'constant-vus',
      vus: 500,
      duration: '2m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'], // <1% failure rate
    http_req_duration: ['p(95)<500'], // 95% of requests under 500ms
  },
};

const BASE_URL = __ENV.TARGET_URL || 'http://localhost:4000';
const EVENT_ID = __ENV.EVENT_ID || 'evt_concert_2026';

export default function () {
  const userId = `usr_${String(Math.floor(Math.random() * 1000) + 1).padStart(5, '0')}`;
  const idemKey = `k6_${userId}_${Date.now()}_${Math.random()}`;

  const headers = {
    'Content-Type': 'application/json',
    'x-user-id': userId,
    'Idempotency-Key': idemKey,
  };

  const rand = Math.random();

  if (rand < 0.30) {
    // 30% Event reads
    const res = http.get(`${BASE_URL}/events/${EVENT_ID}`, { headers });
    check(res, { 'event status 200': (r) => r.status === 200 });
  } else if (rand < 0.60) {
    // 30% Queue joins
    const payload = JSON.stringify({});
    const res = http.post(`${BASE_URL}/events/${EVENT_ID}/queue`, payload, { headers });
    check(res, { 'queue join 200/201': (r) => r.status === 200 || r.status === 201 });
  } else if (rand < 0.90) {
    // 30% Queue status reads
    const res = http.get(`${BASE_URL}/events/${EVENT_ID}/queue/me`, { headers });
    check(res, { 'queue status 200': (r) => r.status === 200 });
  } else {
    // 10% Booking reads
    const res = http.get(`${BASE_URL}/me/bookings`, { headers });
    check(res, { 'booking status 200': (r) => r.status === 200 });
  }

  // Brief pause before next cycle for realistic user simulation
  sleep(0.01);
}
