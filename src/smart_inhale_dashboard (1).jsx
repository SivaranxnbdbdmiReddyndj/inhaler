import React, { useEffect, useState, useRef } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";

const SMARTINHALE_SERVICE = "0000a001-0000-1000-8000-00805f9b34fb";
const CHAR_INHALATION = "0000a002-0000-1000-8000-00805f9b34fb";
const CHAR_DEVICE_CTRL = "0000a004-0000-1000-8000-00805f9b34fb";

function nowTs() { return Date.now(); }
function saveLocal(key, value){ localStorage.setItem(key, JSON.stringify(value)); }
function loadLocal(key, fallback){ const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
function toCsv(rows){ if(!rows.length) return ""; const header = Object.keys(rows[0]); return [header.join(","), ...rows.map(r => header.map(h=>JSON.stringify(r[h] ?? "")).join(","))].join("
"); }

export default function SmartInhaleDashboard(){
  const [events, setEvents] = useState(() => loadLocal("si_events", []));
  const [patients, setPatients] = useState(() => loadLocal("si_patients", [{id: "p1", name: "SivaReddy", deviceId: "device-001"}]));
  const [status, setStatus] = useState("idle");
  const [deviceInfo, setDeviceInfo] = useState(null);
  const deviceRef = useRef(null);

  useEffect(()=> saveLocal("si_events", events), [events]);
  useEffect(()=> saveLocal("si_patients", patients), [patients]);

  async function connectBLE(){
    if(!navigator.bluetooth) { setStatus("Web Bluetooth not supported"); return; }
    try{
      setStatus("requesting device");
      const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [SMARTINHALE_SERVICE] }], optionalServices: ["battery_service"] });
      deviceRef.current = device;
      device.addEventListener('gattserverdisconnected', onDisconnected);
      setStatus('connecting...');
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(SMARTINHALE_SERVICE);
      const char = await service.getCharacteristic(CHAR_INHALATION);
      await char.startNotifications();
      char.addEventListener('characteristicvaluechanged', handleCharacteristic);

      try{ const batt = await server.getPrimaryService('battery_service'); const bchar = await batt.getCharacteristic('battery_level'); const v = await bchar.readValue(); setDeviceInfo({ name: device.name || device.id, battery: v.getUint8(0) }); }
      catch(e){ setDeviceInfo({ name: device.name || device.id }); }

      setStatus('connected');
    }catch(err){ setStatus('ble error: '+(err.message||err)); }
  }

  function onDisconnected(){ setStatus('disconnected'); deviceRef.current = null; }

  function handleCharacteristic(ev){
    const value = ev.target.value;
    try{
      const text = new TextDecoder().decode(value);
      const obj = JSON.parse(text);
      ingestEvent(obj);
    }catch(e){
      // try binary format: ts (8 bytes) strength (4 float) duration (4 float) flags (1 byte)
      try{
        const dv = new DataView(value.buffer);
        const ts = Number(dv.getBigUint64(0));
        const strength = dv.getFloat32(8);
        const duration = dv.getFloat32(12);
        const flags = dv.getUint8(16);
        const obj = { ts, strength, duration, shakeOk: !!(flags & 1), orientationOk: !!(flags & 2) };
        ingestEvent(obj);
      }catch(err){ console.error('unparseable event', err); }
    }
  }

  function ingestEvent(evt){
    const normalized = {
      ts: evt.ts || nowTs(),
      strength: typeof evt.strength === 'number' ? evt.strength : (evt.force || 0),
      duration: typeof evt.duration === 'number' ? evt.duration : (evt.inhale_ms ? evt.inhale_ms/1000 : 0),
      shakeOk: !!evt.shakeOk,
      orientationOk: !!evt.orientationOk,
    };
    setEvents(prev => [normalized, ...prev].slice(0, 1000));
  }

  function exportCsv(){ const csv = toCsv(events.map(e=>({ ts: new Date(e.ts).toISOString(), strength: e.strength, duration: e.duration, shakeOk: e.shakeOk, orientationOk: e.orientationOk }))); const blob = new Blob([csv], {type:'text/csv'}); const url = URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='smartinhale_events.csv'; a.click(); URL.revokeObjectURL(url); }

  function computeAdherence(){ const start = new Date(); start.setHours(0,0,0,0); const todayCount = events.filter(e=>e.ts >= start.getTime()).length; const expected = 2; return Math.min(100, Math.round((todayCount/expected)*100)); }
  function aggregate(){ const map = {}; events.forEach(e=>{ const d = new Date(e.ts).toISOString().slice(0,10); map[d] = map[d] || { date: d, correct:0, wrong:0 }; const ok = e.shakeOk && e.orientationOk && (e.strength>0.5); if(ok) map[d].correct++; else map[d].wrong++; }); return Object.values(map).sort((a,b)=>a.date.localeCompare(b.date)); }

  const adherence = computeAdherence(); const chartData = aggregate();

  return (
    <div className="min-h-screen bg-gray-50 p-6 font-sans">
      <header className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">SmartInhale — Dashboard</h1>
        <div className="flex items-center gap-2">
          <button onClick={connectBLE} className="px-3 py-1 bg-emerald-600 text-white rounded">Connect Device</button>
          <button onClick={exportCsv} className="px-3 py-1 bg-blue-600 text-white rounded">Export CSV</button>
        </div>
      </header>

      <main className="grid grid-cols-3 gap-6">
        <section className="col-span-2 space-y-6">
          <div className="bg-white p-4 rounded shadow flex justify-between items-center">
            <div>
              <div className="text-sm text-gray-600">Adherence</div>
              <div className="text-3xl font-semibold">{adherence}%</div>
              <div className="text-xs text-gray-500">Today's doses: {events.filter(e=>{ const s=new Date(); s.setHours(0,0,0,0); return e.ts>=s.getTime(); }).length}</div>
            </div>
            <div className="text-right">
              <div className="text-sm text-gray-600">Last Event</div>
              <div className="text-lg">{events[0] ? new Date(events[0].ts).toLocaleString() : '—'}</div>
              <div className="text-xs text-gray-500">Status: {status} {deviceInfo ? `| Battery: ${deviceInfo.battery ?? 'N/A'}` : ''}</div>
            </div>
          </div>

          <div className="bg-white p-4 rounded shadow">
            <h3 className="font-semibold mb-3">Weekly Overview</h3>
            <div style={{height:300}}>
              <ResponsiveContainer>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Line dataKey="correct" stroke="#16a34a" />
                  <Line dataKey="wrong" stroke="#dc2626" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="bg-white p-4 rounded shadow">
            <h3 className="font-semibold mb-3">Recent Events</h3>
            <div className="space-y-2 max-h-64 overflow-auto">
              {events.slice(0,50).map((e, i)=> (
                <div key={i} className="p-2 border rounded flex justify-between items-center">
                  <div>
                    <div className="text-sm font-medium">{new Date(e.ts).toLocaleString()}</div>
                    <div className="text-xs text-gray-600">Strength: {(e.strength||0).toFixed(2)} | Duration: {(e.duration||0).toFixed(2)}s</div>
                  </div>
                  <div className={`px-2 py-1 rounded text-xs ${e.shakeOk && e.orientationOk && e.strength>0.5 ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
                    {e.shakeOk && e.orientationOk && e.strength>0.5 ? 'Correct' : 'Improper'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <aside className="col-span-1 space-y-6">
          <div className="bg-white p-4 rounded shadow">
            <h4 className="font-semibold">Device</h4>
            <div className="text-sm text-gray-600">{deviceInfo ? deviceInfo.name : 'No device'}</div>
            <div className="text-xs text-gray-500">{status}</div>
            <div className="mt-3">
              <button onClick={()=>{ if(deviceRef.current && deviceRef.current.gatt) deviceRef.current.gatt.disconnect(); setStatus('disconnected'); }} className="px-3 py-1 bg-red-100 rounded">Disconnect</button>
            </div>
          </div>

          <div className="bg-white p-4 rounded shadow">
            <h4 className="font-semibold">Technique Insights</h4>
            <ul className="text-sm text-gray-700 mt-2 list-disc ml-5">
              <li>Not shaken: {events.filter(e=>!e.shakeOk).length}</li>
              <li>Weak inhale: {events.filter(e=>e.strength<=0.5).length}</li>
              <li>Orientation issues: {events.filter(e=>!e.orientationOk).length}</li>
            </ul>
          </div>

          <div className="bg-white p-4 rounded shadow">
            <h4 className="font-semibold">Quick Actions</h4>
            <div className="mt-2 flex flex-col gap-2">
              <button
  onClick={() => {
    // Generate 5 random events
    for (let i = 0; i < 5; i++) {
      const sample = {
        ts: Date.now() - Math.floor(Math.random() * 3600000), // within last hour
        strength: Math.random().toFixed(2),
        duration: (0.5 + Math.random() * 2).toFixed(2),
        shakeOk: Math.random() > 0.3,
        orientationOk: Math.random() > 0.3,
      };
      ingestEvent(sample);
    }
    setStatus("Simulated 5 events");
  }}
  className="px-3 py-1 bg-indigo-100 rounded"
>
  Simulate BLE Events
</button>

              <button onClick={()=>{ setEvents([]); setStatus('cleared events'); }} className="px-3 py-1 bg-slate-100 rounded">Clear Events</button>
              <button onClick={()=>{ const sample = { ts: nowTs(), strength: 0.8, duration: 1.2, shakeOk: true, orientationOk: true }; ingestEvent(sample); }} className="px-3 py-1 bg-slate-100 rounded">Inject Test Event</button>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}
