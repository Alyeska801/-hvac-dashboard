import { useState, useEffect, useCallback, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

const SENSORS = [
  { id: "CHW-S", label: "Chilled Water", role: "Supply", color: "#4FC3F7", pipe: "cold" },
  { id: "CHW-R", label: "Chilled Water", role: "Return", color: "#81D4FA", pipe: "cold" },
  { id: "HHW-S", label: "Hot Water",     role: "Supply", color: "#FF8A65", pipe: "hot"  },
  { id: "HHW-R", label: "Hot Water",     role: "Return", color: "#FFAB91", pipe: "hot"  },
];
const GAUGE_RANGES = {
  "CHW-S": [44, 75], "CHW-R": [54, 82], "HHW-S": [128, 162], "HHW-R": [108, 142],
};
const ADMIN_PASSWORD = "towers";
const OWNER_PASSWORD = "alyeska";
const DEFAULT_DEGRADED = 57;
const DEFAULT_OFFLINE  = 65;
const AMBIENT_MATCH_DELTA = 8;

function getCWSStatus(cwsTemp, ambientTemp, matchDelta, offlineT, degradedT) {
  if (cwsTemp == null) return "nominal";
  if (ambientTemp !== null && cwsTemp >= ambientTemp - matchDelta) return "offline";
  if (cwsTemp >= offlineT)  return "offline";
  if (cwsTemp >= degradedT) return "degraded";
  return "nominal";
}
function getSensorStatus(id, val, degradedT = DEFAULT_DEGRADED, offlineT = DEFAULT_OFFLINE) {
  if (val == null) return "normal";
  if (id === "CHW-S") return val >= offlineT ? "critical" : val >= degradedT ? "warning" : "normal";
  const t = { "CHW-R": {w:68,c:75}, "HHW-S": {w:148,c:155}, "HHW-R": {w:128,c:135} }[id];
  if (!t) return "normal";
  return val >= t.c ? "critical" : val >= t.w ? "warning" : "normal";
}

const STATUS_META = {
  nominal:  { color:"#4CAF50", bg:"#0d2218", border:"#4CAF5040", label:"NOMINAL",  baseMsg:null },
  degraded: { color:"#FFA726", bg:"#261a04", border:"#FFA72640", label:"DEGRADED", baseMsg:"You may notice cooling takes longer than usual." },
  offline:  { color:"#EF5350", bg:"#220808", border:"#EF535040", label:"OFFLINE",  baseMsg:"Chilled water is not circulating in the building." },
};
const ENG_STATES = {
  none:        { suffix: null },
  aware:       { suffix: "Building engineering is aware and investigating." },
  maintenance: { suffix: null },
};

function fmtTime(d)  { return d.toLocaleTimeString("en-US", {hour:"2-digit",minute:"2-digit",second:"2-digit"}); }
function fmtDate(d)  { return d.toLocaleDateString("en-US", {weekday:"short",month:"short",day:"numeric"}); }
function fmtShort(ts){ return new Date(ts).toLocaleDateString("en-US", {month:"short",day:"numeric"}); }
function fmtChartTime(ts, w) {
  const d = new Date(ts);
  if (w === "24h") return d.toLocaleTimeString("en-US", {hour:"2-digit",minute:"2-digit"});
  if (w === "1m")  return d.toLocaleDateString("en-US", {month:"short",day:"numeric"});
  return d.toLocaleDateString("en-US", {month:"short",day:"numeric"});
}
function fmtChartTooltip(ts, w) {
  const d = new Date(ts);
  if (w === "24h") return d.toLocaleString("en-US", {month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
  return d.toLocaleString("en-US", {month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
}

function Sparkline({ data, color, width=210, height=34 }) {
  if (!data||data.length<2) return null;
  const vals=data.map(d=>d.value);
  const times=data.map(d=>d.time);
  const mn=Math.min(...vals)-1, mx=Math.max(...vals)+1, rng=mx-mn||1;
  const pts=vals.map((v,i)=>`${(i/(vals.length-1))*width},${height-((v-mn)/rng)*height}`);
  const coords=vals.map((v,i)=>({
    x:(i/(vals.length-1))*width,
    y:height-((v-mn)/rng)*height,
    v,
    t:times[i],
  }));
  return (
    <svg width={width} height={height} style={{overflow:"visible",display:"block"}}>
      <defs><linearGradient id={`sg${color.slice(1)}`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={color} stopOpacity="0.2"/>
        <stop offset="100%" stopColor={color} stopOpacity="0.01"/>
      </linearGradient></defs>
      <path d={`M${pts.join("L")}L${width},${height}L0,${height}Z`} fill={`url(#sg${color.slice(1)})`}/>
      <path d={`M${pts.join("L")}`} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      {coords.map((c,i)=>(
        <circle key={i} cx={c.x} cy={c.y} r={6} fill="transparent" style={{cursor:"crosshair"}}>
          <title>{c.t ? new Date(c.t).toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"}) : ""} — {c.v}°F</title>
        </circle>
      ))}
    </svg>
  );
}

function Gauge({ value, min, max, color, status }) {
  const pct=Math.max(0,Math.min(1,((value??min)-min)/(max-min)));
  const nc={normal:"#4CAF50",warning:"#FFA726",critical:"#EF5350"}[status]||"#ccc";
  return (
    <svg width="90" height="62" viewBox="0 0 90 62">
      <path d="M8,58 A38,38 0 0,1 82,58" fill="none" stroke="#1a2535" strokeWidth="7" strokeLinecap="round"/>
      <path d="M8,58 A38,38 0 0,1 82,58" fill="none" stroke={color} strokeWidth="4"
        strokeDasharray={`${pct*119.4} 119.4`} strokeLinecap="round" opacity="0.65"/>
      <g transform={`rotate(${-135+pct*270},45,58)`}>
        <line x1="45" y1="58" x2="45" y2="26" stroke={nc} strokeWidth="2.2" strokeLinecap="round"/>
        <circle cx="45" cy="58" r="3.5" fill={nc}/>
      </g>
    </svg>
  );
}

function UptimeBar({ uptime }) {
  if (!uptime) return null;
  const {nominal,degraded,offline,segments}=uptime;
  const sc={nominal:"#4CAF50",degraded:"#FFA726",offline:"#EF5350",unknown:"#1e2d45"};
  return (
    <div style={{marginTop:12}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
        <span style={{fontSize:9,color:"#3a6a8a",fontFamily:"'DM Mono',monospace",letterSpacing:1}}>7-DAY UPTIME</span>
        <div style={{display:"flex",gap:10}}>
          {[["NOMINAL",nominal,"#4CAF50"],["DEGRADED",degraded,"#FFA726"],["OFFLINE",offline,"#EF5350"]].map(([l,p,c])=>(
            <span key={l} style={{fontSize:9,fontFamily:"'DM Mono',monospace",color:c}}>{l} {p}%</span>
          ))}
        </div>
      </div>
      <div style={{height:8,borderRadius:4,overflow:"hidden",display:"flex",background:"#1e2d45"}}>
        {segments&&segments.map((seg,i)=>(
          <div key={i} style={{flex:1,background:sc[seg.status],opacity:0.85}}
            title={`${new Date(seg.ts).toLocaleString()} — ${seg.status.toUpperCase()}`}/>
        ))}
      </div>
      <div style={{display:"flex",justifyContent:"space-between",marginTop:3}}>
        <span style={{fontSize:8,color:"#1e3a55",fontFamily:"'DM Mono',monospace"}}>7 days ago</span>
        <span style={{fontSize:8,color:"#1e3a55",fontFamily:"'DM Mono',monospace"}}>now</span>
      </div>
    </div>
  );
}

function SensorCard({ sensor, reading, history, uptime, cwsStatus, degradedT, offlineT, onViewHistory, onAnalyze }) {
  const status=getSensorStatus(sensor.id,reading,degradedT,offlineT);
  const sdot={normal:"#4CAF50",warning:"#FFA726",critical:"#EF5350"}[status];
  const sbg ={normal:"#1b3a2a",warning:"#3a2a0a",critical:"#3a0a0a"}[status];
  const slbl={normal:"NOMINAL",warning:"ELEVATED",critical:"ALERT"}[status];
  const [gMin,gMax]=GAUGE_RANGES[sensor.id];
  const isCWS=sensor.id==="CHW-S";
  return (
    <div style={{background:"linear-gradient(135deg,#0d1b2e 0%,#0a1525 100%)",border:"1px solid #1e2d45",borderRadius:12,padding:"18px 18px 14px",position:"relative",overflow:"hidden"}}>
      <div style={{position:"absolute",top:12,right:12,background:sbg,border:`1px solid ${sdot}40`,borderRadius:20,padding:"3px 10px",display:"flex",alignItems:"center",gap:5}}>
        <div style={{width:6,height:6,borderRadius:"50%",background:sdot,boxShadow:status!=="normal"?`0 0 6px ${sdot}`:"none",animation:status!=="normal"?"pulse 1.5s infinite":"none"}}/>
        <span style={{fontSize:9,fontFamily:"'DM Mono',monospace",color:sdot,letterSpacing:1}}>{slbl}</span>
      </div>
      <div style={{marginBottom:2}}>
        <div style={{fontSize:10,color:sensor.color,fontFamily:"'DM Mono',monospace",letterSpacing:2,opacity:0.85}}>{sensor.pipe==="cold"?"❄":"🔥"} {sensor.label.toUpperCase()}</div>
        <div style={{fontSize:12,color:"#6a8eaa",fontFamily:"'DM Mono',monospace",letterSpacing:1}}>{sensor.role.toUpperCase()}</div>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:10,marginTop:6}}>
        <Gauge value={reading} min={gMin} max={gMax} color={sensor.color} status={status}/>
        <div>
          <div style={{fontSize:36,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",color:"#e8f4fd",lineHeight:1}}>{reading??"—"}</div>
          <div style={{fontSize:13,color:"#3a6a8a",fontFamily:"'DM Mono',monospace"}}>°F</div>
        </div>
      </div>
      <div style={{marginTop:10}}>
        {history&&history.length>=2
          ? <Sparkline data={history} color={sensor.color}/>
          : <div style={{height:34,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:"#1e3a55",fontFamily:"'DM Mono',monospace",letterSpacing:1}}>COLLECTING DATA...</div>}
      </div>
      {isCWS&&<UptimeBar uptime={uptime}/>}
      {isCWS&&(
        <div style={{display:"flex",gap:8,marginTop:10}}>
          <button onClick={onViewHistory} style={{flex:1,background:"#0a1828",border:"1px solid #1e3a55",borderRadius:6,color:"#4a7fa5",padding:"7px",fontSize:10,fontFamily:"'DM Mono',monospace",cursor:"pointer",letterSpacing:1,transition:"all 0.2s"}}
            onMouseEnter={e=>{e.target.style.borderColor="#4a7fa5";e.target.style.color="#81b4d4";}}
            onMouseLeave={e=>{e.target.style.borderColor="#1e3a55";e.target.style.color="#4a7fa5";}}>
            📊 OUTAGE HISTORY
          </button>
          {(cwsStatus==="offline"||cwsStatus==="degraded")&&(
            <button onClick={onAnalyze} style={{flex:1,background:"#220808",border:"1px solid #EF535088",borderRadius:6,color:"#EF5350",padding:"7px",fontSize:10,fontFamily:"'DM Mono',monospace",cursor:"pointer",letterSpacing:1,animation:"pulse 2s infinite"}}
              onMouseEnter={e=>e.target.style.background="#3a0a0a"}
              onMouseLeave={e=>e.target.style.background="#220808"}>
              🔴 OUTAGE ANALYSIS
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DeltaBadge({ label, a, b, colorA, colorB }) {
  if (a==null||b==null) return null;
  const delta=+(b-a).toFixed(1);
  const dc=delta>15?"#EF5350":delta>8?"#FFA726":"#4CAF50";
  return (
    <div style={{background:"#0a1525",border:"1px solid #1e2d45",borderRadius:8,padding:"12px 14px",textAlign:"center"}}>
      <div style={{fontSize:9,color:"#3a6a8a",fontFamily:"'DM Mono',monospace",letterSpacing:1,marginBottom:6}}>{label}</div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
        <span style={{color:colorA,fontFamily:"'Barlow Condensed',sans-serif",fontSize:17,fontWeight:700}}>{a}°</span>
        <span style={{color:"#1e3050",fontSize:11}}>→</span>
        <span style={{color:colorB,fontFamily:"'Barlow Condensed',sans-serif",fontSize:17,fontWeight:700}}>{b}°</span>
      </div>
      <div style={{marginTop:5,fontSize:20,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",color:dc}}>Δ {delta>0?"+":""}{delta}°F</div>
    </div>
  );
}

function StatusBanner({ cwsStatus, engState, eta, situationFlag }) {
  const meta=STATUS_META[cwsStatus];
  if (cwsStatus==="nominal"&&engState==="none"&&!situationFlag) return null;
  let msg=meta.baseMsg||"";
  if (engState==="aware") msg=[msg,ENG_STATES.aware.suffix].filter(Boolean).join(" ");
  else if (engState==="maintenance") {
    const etaPart=eta?`Estimated return to service: ${eta}.`:"Return to service time is being determined.";
    msg=[msg,"System is offline for scheduled maintenance.",etaPart].filter(Boolean).join(" ");
  }
  if (situationFlag) msg=[msg,situationFlag].filter(Boolean).join(" ");
  if (!msg) return null;
  return (
    <div style={{marginTop:16,background:meta.bg,border:`1px solid ${meta.border}`,borderRadius:8,padding:"11px 16px",display:"flex",alignItems:"flex-start",gap:10}}>
      <span style={{fontSize:14,marginTop:1,flexShrink:0}}>{cwsStatus==="offline"?"🔴":cwsStatus==="degraded"?"🟡":"🔵"}</span>
      <span style={{fontSize:13,color:cwsStatus==="offline"?"#ef9a9a":cwsStatus==="degraded"?"#ffcc80":"#90caf9",lineHeight:1.6}}>{msg}</span>
    </div>
  );
}

function HistoryChart({ window, setWindow, degradedT, offlineT }) {
  const [data,setData]=useState(null);
  const [loading,setLoading]=useState(true);
  useEffect(()=>{
    setLoading(true);
    fetch(`/api/history?window=${window}`).then(r=>r.json()).then(d=>{setData(d);setLoading(false);}).catch(()=>setLoading(false));
  },[window]);
  const windows=["24h","1m","3m","6m"];
  const windowLabels={"24h":"24 Hours","1m":"1 Month","3m":"3 Months","6m":"6 Months"};
  const CustomTooltip=({active,payload,label})=>{
    if(!active||!payload?.length) return null;
    return (
      <div style={{background:"#07111f",border:"1px solid #1e3a55",borderRadius:8,padding:"10px 14px",fontFamily:"'DM Mono',monospace"}}>
        <div style={{fontSize:10,color:"#3a6a8a",marginBottom:6}}>{fmtChartTooltip(label,window)}</div>
        {payload.map(p=><div key={p.dataKey} style={{fontSize:12,color:p.color}}>{p.name}: {p.value}°F</div>)}
      </div>
    );
  };
  return (
    <div style={{background:"#0a1525",border:"1px solid #1e2d45",borderRadius:12,padding:"20px",marginBottom:22}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:8}}>
        <div style={{fontSize:10,color:"#2a5a7a",letterSpacing:3}}>CHILLED WATER SUPPLY HISTORY</div>
        <div style={{display:"flex",gap:6}}>
          {windows.map(w=>(
            <button key={w} onClick={()=>setWindow(w)} style={{background:window===w?"#1a3a5a":"transparent",border:`1px solid ${window===w?"#2a5a8a":"#1e2d45"}`,borderRadius:6,color:window===w?"#81b4d4":"#3a6a8a",padding:"4px 10px",fontSize:10,fontFamily:"'DM Mono',monospace",cursor:"pointer",letterSpacing:1}}>{windowLabels[w]}</button>
          ))}
        </div>
      </div>
      {loading?(
        <div style={{height:200,display:"flex",alignItems:"center",justifyContent:"center",color:"#2a4a6a",fontFamily:"'DM Mono',monospace",fontSize:11}}>LOADING DATA...</div>
      ):!data?.points?.length?(
        <div style={{height:200,display:"flex",alignItems:"center",justifyContent:"center",color:"#2a4a6a",fontFamily:"'DM Mono',monospace",fontSize:11}}>NO DATA FOR THIS WINDOW YET</div>
      ):(
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data.points} margin={{top:5,right:10,left:0,bottom:5}}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e2d45"/>
            <XAxis dataKey="ts" tickFormatter={ts=>fmtChartTime(ts,window)} tick={{fill:"#3a6a8a",fontSize:9,fontFamily:"'DM Mono',monospace"}} tickLine={false} axisLine={{stroke:"#1e2d45"}} interval="preserveStartEnd"/>
            <YAxis tick={{fill:"#3a6a8a",fontSize:9,fontFamily:"'DM Mono',monospace"}} tickLine={false} axisLine={false} domain={["auto","auto"]} tickFormatter={v=>`${v}°`} width={35}/>
            <Tooltip content={<CustomTooltip/>}/>
            <ReferenceLine y={degradedT} stroke="#FFA726" strokeDasharray="4 4" strokeOpacity={0.5} label={{value:"DEGRADED",fill:"#FFA726",fontSize:8,fontFamily:"'DM Mono',monospace"}}/>
            <ReferenceLine y={offlineT}  stroke="#EF5350" strokeDasharray="4 4" strokeOpacity={0.5} label={{value:"OFFLINE", fill:"#EF5350",fontSize:8,fontFamily:"'DM Mono',monospace"}}/>
            <Line type="monotone" dataKey="CHW-S" name="CW Supply" stroke="#4FC3F7" strokeWidth={1.5} dot={false} connectNulls/>
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function OutageHistoryModal({ onClose, degradedT, offlineT }) {
  const [data,setData]=useState(null);
  const [loading,setLoading]=useState(true);
  useEffect(()=>{
    fetch("/api/outages").then(r=>r.json()).then(d=>{setData(d);setLoading(false);}).catch(()=>setLoading(false));
  },[]);
  const severityColor=peak=>peak>=73?"#EF5350":peak>=69?"#FF7043":"#FFA726";
  return (
    <div onClick={e=>{if(e.target===e.currentTarget)onClose();}}
      style={{position:"fixed",inset:0,zIndex:300,background:"rgba(0,5,15,0.85)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{background:"#07111f",border:"1px solid #2a4a6a",borderRadius:14,padding:"24px 28px",width:"100%",maxWidth:720,maxHeight:"85vh",overflowY:"auto",boxShadow:"0 12px 50px #000e",fontFamily:"'DM Mono',monospace"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,paddingBottom:14,borderBottom:"1px solid #1a2d45"}}>
          <div>
            <div style={{fontSize:14,color:"#e8f4fd",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,letterSpacing:1}}>CHILLER OUTAGE HISTORY</div>
            <div style={{fontSize:10,color:"#3a6a8a",letterSpacing:1,marginTop:2}}>AMERICAN TOWERS · SALT LAKE CITY</div>
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#3a6a8a",cursor:"pointer",fontSize:18,padding:0}}>✕</button>
        </div>
        {loading?(
          <div style={{padding:"40px 0",textAlign:"center",color:"#3a6a8a",fontSize:11,letterSpacing:2}}>LOADING OUTAGE DATA...</div>
        ):!data?.outages?.length?(
          <div style={{padding:"40px 0",textAlign:"center",color:"#3a6a8a",fontSize:11}}>No outage events found.</div>
        ):(
          <>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:24}}>
              {[["TOTAL OUTAGES",data.stats.totalOutages,"#EF5350"],["TOTAL OFFLINE",`${data.stats.offlineHrs}h`,"#FFA726"],["UPTIME (6MO)",`${data.stats.uptimePct}%`,"#4CAF50"]].map(([label,value,color])=>(
                <div key={label} style={{background:"#0a1525",border:"1px solid #1e2d45",borderRadius:8,padding:"12px",textAlign:"center"}}>
                  <div style={{fontSize:9,color:"#3a6a8a",letterSpacing:1,marginBottom:6}}>{label}</div>
                  <div style={{fontSize:26,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",color}}>{value}</div>
                </div>
              ))}
            </div>
            <div style={{marginBottom:20}}>
              <div style={{fontSize:10,color:"#2a5a7a",letterSpacing:2,marginBottom:12}}>EVENT TIMELINE</div>
              {data.outages.map((o,i)=>{
                const color=severityColor(o.peakTemp);
                const widthPct=Math.min(100,Math.max(2,(o.durationHrs/30)*100));
                return (
                  <div key={i} style={{marginBottom:10}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        {o.ongoing&&<div style={{width:6,height:6,borderRadius:"50%",background:"#EF5350",boxShadow:"0 0 6px #EF5350",animation:"pulse 1.2s infinite"}}/>}
                        <span style={{fontSize:11,color:"#c8dff0"}}>
                          {fmtShort(o.start)} {new Date(o.start).toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"})}
                          {o.end?` → ${fmtShort(o.end)} ${new Date(o.end).toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"})}`:" → ONGOING"}
                        </span>
                      </div>
                      <div style={{display:"flex",gap:12,fontSize:10}}>
                        <span style={{color}}>{o.durationHrs}h</span>
                        <span style={{color}}>peak {o.peakTemp}°F</span>
                        {o.ambientDelta!=null&&<span style={{color:"#4a7fa5"}}>+{o.ambientDelta}° above ambient</span>}
                      </div>
                    </div>
                    <div style={{height:6,background:"#0a1525",borderRadius:3,overflow:"hidden"}}>
                      <div style={{height:"100%",width:`${widthPct}%`,background:color,borderRadius:3,opacity:0.8}}/>
                    </div>
                  </div>
                );
              })}
              <div style={{fontSize:9,color:"#1e3a55",marginTop:8}}>Bar width proportional to duration (max 30h scale)</div>
            </div>
            <div>
              <div style={{fontSize:10,color:"#2a5a7a",letterSpacing:2,marginBottom:12}}>PEAK TEMPERATURE BY EVENT</div>
              <ResponsiveContainer width="100%" height={140}>
                <LineChart data={data.outages.map((o,i)=>({name:fmtShort(o.start),peak:o.peakTemp,ambient:o.ambientAvg,index:i+1}))} margin={{top:5,right:10,left:0,bottom:5}}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e2d45"/>
                  <XAxis dataKey="name" tick={{fill:"#3a6a8a",fontSize:9,fontFamily:"'DM Mono',monospace"}} tickLine={false} axisLine={{stroke:"#1e2d45"}}/>
                  <YAxis tick={{fill:"#3a6a8a",fontSize:9,fontFamily:"'DM Mono',monospace"}} tickLine={false} axisLine={false} domain={[50,80]} tickFormatter={v=>`${v}°`} width={32}/>
                  <Tooltip contentStyle={{background:"#07111f",border:"1px solid #1e3a55",borderRadius:8,fontFamily:"'DM Mono',monospace",fontSize:11}} formatter={(v,n)=>[`${v}°F`,n==="peak"?"Peak CWS":"Avg Ambient"]}/>
                  <ReferenceLine y={offlineT} stroke="#EF5350" strokeDasharray="4 4" strokeOpacity={0.5}/>
                  <Line type="monotone" dataKey="peak" stroke="#EF5350" strokeWidth={2} dot={{fill:"#EF5350",r:4}} name="peak"/>
                  <Line type="monotone" dataKey="ambient" stroke="#4a7fa5" strokeWidth={1.5} dot={{fill:"#4a7fa5",r:3}} strokeDasharray="4 4" name="ambient"/>
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function OutageAnalysisModal({ onClose, currentReading, cwsStatus }) {
  const [analysis,setAnalysis]=useState("");
  const [loading,setLoading]=useState(true);
  useEffect(()=>{
    async function run() {
      try {
        const [histRes,outageRes]=await Promise.all([fetch("/api/history?window=6m"),fetch("/api/outages")]);
        const [histData,outageData]=await Promise.all([histRes.json(),outageRes.json()]);
        const recentPoints=(histData?.points||[]).slice(-72).map(p=>`${new Date(p.ts).toISOString().slice(11,16)} ${p["CHW-S"]}°F`).join("\n");
        const outagesSummary=(outageData?.outages||[]).map(o=>`${new Date(o.start).toLocaleDateString("en-US",{month:"short",day:"numeric"})} — ${o.durationHrs}h, peak ${o.peakTemp}°F${o.ambientDelta!=null?`, +${o.ambientDelta}° above ambient`:""}`).join("\n");
        const response=await fetch("/api/analyze",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({summary:`CURRENT STATUS: ${cwsStatus.toUpperCase()} at ${currentReading}°F\n\nRECENT TREND (last 6 hours):\n${recentPoints}\n\nPAST OUTAGE EVENTS:\n${outagesSummary}`,cwsStatus,currentReading,mode:"current"})});
        const data=await response.json();
        setAnalysis(data.analysis);
      } catch { setAnalysis("Failed to generate analysis. Please try again."); }
      setLoading(false);
    }
    run();
  },[]);
  return (
    <div onClick={e=>{if(e.target===e.currentTarget)onClose();}}
      style={{position:"fixed",inset:0,zIndex:300,background:"rgba(20,0,0,0.88)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{background:"#0f0505",border:"1px solid #EF535044",borderRadius:14,padding:"24px 28px",width:"100%",maxWidth:640,maxHeight:"80vh",overflowY:"auto",boxShadow:"0 12px 50px #000e",fontFamily:"'DM Mono',monospace"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,paddingBottom:14,borderBottom:"1px solid #2a0a0a"}}>
          <div>
            <div style={{fontSize:14,color:"#ef9a9a",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,letterSpacing:1}}>🔴 ACTIVE OUTAGE ANALYSIS</div>
            <div style={{fontSize:10,color:"#6a2a2a",letterSpacing:1,marginTop:2}}>AI-POWERED · CURRENT SITUATION VS HISTORICAL PATTERNS</div>
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#6a2a2a",cursor:"pointer",fontSize:18,padding:0}}>✕</button>
        </div>
        {loading?(
          <div style={{padding:"40px 0",textAlign:"center"}}>
            <div style={{fontSize:11,color:"#6a2a2a",letterSpacing:2,marginBottom:8}}>ANALYZING CURRENT SITUATION...</div>
            <div style={{fontSize:10,color:"#3a1010"}}>Comparing to historical outage signatures</div>
          </div>
        ):(
          <div style={{fontSize:13,color:"#f5c6c6",lineHeight:1.8,whiteSpace:"pre-wrap"}}>{analysis}</div>
        )}
      </div>
    </div>
  );
}

function Toggle({ on, onChange, label, sublabel, locked }) {
  return (
    <div onClick={()=>!locked&&onChange(!on)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:on?"#0d1e30":"#0a1220",border:`1px solid ${on?"#2a5a8a":"#1a2a3a"}`,borderRadius:8,padding:"10px 12px",cursor:locked?"default":"pointer",transition:"all 0.2s",opacity:locked?0.5:1}}>
      <div>
        <div style={{fontSize:11,color:on?"#81b4d4":"#3a6a8a",fontFamily:"'DM Mono',monospace",letterSpacing:0.5}}>{label}</div>
        {sublabel&&<div style={{fontSize:9,color:"#2a4a60",marginTop:2,fontFamily:"'DM Mono',monospace"}}>{sublabel}</div>}
      </div>
      <div style={{width:36,height:20,borderRadius:10,flexShrink:0,marginLeft:12,background:on?"#1a4a7a":"#0a1828",border:`1px solid ${on?"#3a7aaa":"#1e3a55"}`,position:"relative",transition:"all 0.2s"}}>
        <div style={{position:"absolute",top:3,left:on?17:3,width:12,height:12,borderRadius:"50%",background:on?"#4FC3F7":"#2a4a60",transition:"left 0.2s, background 0.2s",boxShadow:on?"0 0 6px #4FC3F760":"none"}}/>
      </div>
    </div>
  );
}

function AdminPanel({ ambientTemp,setAmbientTemp,matchDelta,setMatchDelta,
                      engState,setEngState,eta,setEta,situationFlag,setSituationFlag,
                      alertRecipients,setAlertRecipients,sendRecoveryEmails,setSendRecoveryEmails,
                      degradedThreshold,setDegradedThreshold,offlineThreshold,setOfflineThreshold,
                      warnRateOfRise,setWarnRateOfRise,warnCooldownHours,setWarnCooldownHours,
                      showHot,setShowHot,onClose,onSave,saving }) {
  const [ambDraft,setAmbDraft]=useState(ambientTemp??"");
  const [deltaDraft,setDeltaDraft]=useState(matchDelta);
  const [ownerUnlocked,setOwnerUnlocked]=useState(false);
  const [ownerDraft,setOwnerDraft]=useState("");
  const [ownerError,setOwnerError]=useState(false);
  const btnBase={flex:1,borderRadius:7,padding:"9px 8px",fontSize:11,fontFamily:"'DM Mono',monospace",cursor:"pointer",letterSpacing:0.5,border:"1px solid",transition:"all 0.15s",textAlign:"center"};
  const activeBtn=c=>({...btnBase,background:`${c}22`,borderColor:`${c}88`,color:c});
  const inactiveBtn=()=>({...btnBase,background:"#0a1828",borderColor:"#1e3a55",color:"#3a6a8a"});

  return (
    <div style={{position:"fixed",bottom:24,right:24,zIndex:100,background:"#07111f",border:"1px solid #2a4a6a",borderRadius:14,padding:"20px 22px",width:320,boxShadow:"0 8px 40px #000c",fontFamily:"'DM Mono',monospace",maxHeight:"90vh",overflowY:"auto"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,paddingBottom:12,borderBottom:"1px solid #1a2d45"}}>
        <span style={{fontSize:10,color:"#4a7fa5",letterSpacing:2}}>⚙ ENGINEERING ADMIN</span>
        <button onClick={onClose} style={{background:"none",border:"none",color:"#3a6a8a",cursor:"pointer",fontSize:16,padding:0}}>✕</button>
      </div>

      {/* Sensor visibility — owner only */}
      <div style={{marginBottom:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <div style={{fontSize:10,color:"#3a6080",letterSpacing:1}}>SENSOR VISIBILITY</div>
          {!ownerUnlocked&&(
            <div style={{display:"flex",gap:6,alignItems:"center"}}>
              <input type="password" value={ownerDraft} onChange={e=>{setOwnerDraft(e.target.value);setOwnerError(false);}}
                onKeyDown={e=>{if(e.key==="Enter"){if(ownerDraft===OWNER_PASSWORD){setOwnerUnlocked(true);setOwnerDraft("");}else{setOwnerError(true);setOwnerDraft("");}}}}
                placeholder="Owner PIN"
                style={{width:90,background:"#0a1828",border:`1px solid ${ownerError?"#EF5350":"#1e3a55"}`,borderRadius:5,color:"#c8dff0",padding:"4px 8px",fontSize:10,fontFamily:"'DM Mono',monospace",outline:"none"}}/>
              <span style={{fontSize:9,color:"#1e3a55"}}>🔒</span>
            </div>
          )}
          {ownerUnlocked&&<span style={{fontSize:9,color:"#4CAF50"}}>🔓 UNLOCKED</span>}
        </div>
        <Toggle on={showHot} onChange={setShowHot} locked={!ownerUnlocked} label="Hot water sensors (HWS / HWR)" sublabel="Hide when valves closed for service"/>
      </div>
      <div style={{borderTop:"1px solid #1a2d45",marginBottom:14}}/>

      {/* Situation flag */}
      <div style={{marginBottom:14}}>
        <div style={{fontSize:10,color:"#3a6080",letterSpacing:1,marginBottom:6}}>SITUATION NOTE (shown on dashboard)</div>
        <textarea value={situationFlag} onChange={e=>setSituationFlag(e.target.value)} placeholder="e.g. Chiller compressor replaced, monitoring for stability..." rows={2}
          style={{width:"100%",background:"#0a1828",border:"1px solid #1e3a55",borderRadius:6,color:"#c8dff0",padding:"7px 10px",fontSize:11,fontFamily:"'DM Mono',monospace",outline:"none",resize:"vertical"}}/>
      </div>
      <div style={{borderTop:"1px solid #1a2d45",marginBottom:14}}/>

      {/* Banner override */}
      <div style={{marginBottom:14}}>
        <div style={{fontSize:10,color:"#3a6080",letterSpacing:1,marginBottom:8}}>BANNER STATUS OVERRIDE</div>
        <div style={{display:"flex",flexDirection:"column",gap:7}}>
          <button onClick={()=>setEngState("none")}        style={engState==="none"        ?activeBtn("#4a7fa5"):inactiveBtn()}>No override — sensor-driven only</button>
          <button onClick={()=>setEngState("aware")}       style={engState==="aware"       ?activeBtn("#FFA726"):inactiveBtn()}>We're aware &amp; investigating</button>
          <button onClick={()=>setEngState("maintenance")} style={engState==="maintenance" ?activeBtn("#4CAF50"):inactiveBtn()}>Offline for scheduled service</button>
        </div>
        {engState==="maintenance"&&(
          <div style={{marginTop:10}}>
            <div style={{fontSize:10,color:"#3a6080",letterSpacing:1,marginBottom:5}}>ESTIMATED RETURN TO SERVICE</div>
            <input type="text" value={eta} onChange={e=>setEta(e.target.value)} placeholder="e.g. Friday, June 6 by 5:00 PM"
              style={{width:"100%",background:"#0a1828",border:"1px solid #1e3a55",borderRadius:6,color:"#c8dff0",padding:"7px 10px",fontSize:12,fontFamily:"'DM Mono',monospace",outline:"none"}}/>
          </div>
        )}
      </div>
      <div style={{borderTop:"1px solid #1a2d45",marginBottom:14}}/>

      {/* Alert recipients */}
      <div style={{marginBottom:14}}>
        <div style={{fontSize:10,color:"#3a6080",letterSpacing:1,marginBottom:6}}>ALERT RECIPIENTS (one per line)</div>
        <textarea value={alertRecipients.join("\n")} onChange={e=>setAlertRecipients(e.target.value.split("\n").map(s=>s.trim()).filter(Boolean))}
          placeholder={"engineer@building.com\nmanager@building.com"} rows={4}
          style={{width:"100%",background:"#0a1828",border:"1px solid #1e3a55",borderRadius:6,color:"#c8dff0",padding:"7px 10px",fontSize:11,fontFamily:"'DM Mono',monospace",outline:"none",resize:"vertical"}}/>
      </div>
      {/* Recovery emails toggle */}
      <div style={{marginBottom:14}}>
        <Toggle on={sendRecoveryEmails} onChange={setSendRecoveryEmails} label="Send recovery emails" sublabel="Notify when system returns to nominal"/>
      </div>
      <div style={{borderTop:"1px solid #1a2d45",marginBottom:14}}/>

      {/* Owner-only settings */}
      {ownerUnlocked&&<>
        {/* Thresholds */}
        <div style={{marginBottom:14}}>
          <div style={{fontSize:10,color:"#3a6080",letterSpacing:1,marginBottom:8}}>CWS TEMPERATURE THRESHOLDS (°F)</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            {[["DEGRADED ≥",degradedThreshold,setDegradedThreshold],["OFFLINE ≥",offlineThreshold,setOfflineThreshold]].map(([label,val,setter])=>(
              <div key={label}>
                <div style={{fontSize:9,color:"#3a6080",letterSpacing:1,marginBottom:4}}>{label}</div>
                <div style={{display:"flex",gap:4,alignItems:"center"}}>
                  <input type="number" value={val} onChange={e=>setter(parseFloat(e.target.value)||57)}
                    style={{flex:1,background:"#0a1828",border:"1px solid #1e3a55",borderRadius:6,color:"#c8dff0",padding:"7px 8px",fontSize:13,fontFamily:"'DM Mono',monospace",outline:"none",textAlign:"center"}}/>
                  <span style={{fontSize:11,color:"#3a6a8a"}}>°F</span>
                </div>
              </div>
            ))}
          </div>
          <div style={{marginTop:6,fontSize:9,color:"#2a4050"}}>
            nominal &lt;{degradedThreshold}°F · degraded {degradedThreshold}–{offlineThreshold}°F · offline ≥{offlineThreshold}°F
          </div>
        </div>

        {/* Rate of rise + cooldown */}
        <div style={{marginBottom:14}}>
          <div style={{fontSize:10,color:"#3a6080",letterSpacing:1,marginBottom:8}}>ALERT THRESHOLDS</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <div>
              <div style={{fontSize:9,color:"#3a6080",letterSpacing:0.5,marginBottom:4}}>WARN RATE (°F/10min)</div>
              <input type="number" value={warnRateOfRise} step="0.1" onChange={e=>setWarnRateOfRise(parseFloat(e.target.value)||0.5)}
                style={{width:"100%",background:"#0a1828",border:"1px solid #1e3a55",borderRadius:6,color:"#c8dff0",padding:"7px 8px",fontSize:13,fontFamily:"'DM Mono',monospace",outline:"none",textAlign:"center"}}/>
            </div>
            <div>
              <div style={{fontSize:9,color:"#3a6080",letterSpacing:0.5,marginBottom:4}}>COOLDOWN (hours)</div>
              <input type="number" value={warnCooldownHours} onChange={e=>setWarnCooldownHours(parseFloat(e.target.value)||1)}
                style={{width:"100%",background:"#0a1828",border:"1px solid #1e3a55",borderRadius:6,color:"#c8dff0",padding:"7px 8px",fontSize:13,fontFamily:"'DM Mono',monospace",outline:"none",textAlign:"center"}}/>
            </div>
          </div>
          <div style={{marginTop:6,fontSize:9,color:"#2a4050"}}>
            Warning fires at ≥{warnRateOfRise}°F/10min · {warnCooldownHours}h between warnings
          </div>
        </div>

        {/* Ambient */}
        <div style={{marginBottom:12}}>
          <div style={{fontSize:10,color:"#3a6080",letterSpacing:1,marginBottom:6}}>AMBIENT TEMPERATURE (°F)</div>
          <div style={{display:"flex",gap:8}}>
            <input type="number" value={ambDraft} onChange={e=>setAmbDraft(e.target.value)} placeholder="e.g. 72"
              style={{flex:1,background:"#0a1828",border:"1px solid #1e3a55",borderRadius:6,color:"#c8dff0",padding:"7px 10px",fontSize:13,fontFamily:"'DM Mono',monospace",outline:"none"}}/>
            <button onClick={()=>setAmbientTemp(ambDraft===""?null:parseFloat(ambDraft))}
              style={{background:"#1a3a5a",border:"1px solid #2a5a8a",borderRadius:6,color:"#81b4d4",fontSize:11,fontFamily:"'DM Mono',monospace",cursor:"pointer",padding:"7px 12px",letterSpacing:1}}>SET</button>
          </div>
          {ambientTemp!==null
            ?<div style={{marginTop:5,fontSize:10,color:"#2a6a4a"}}>✓ Ambient {ambientTemp}°F · offline trigger ≤ {(ambientTemp-matchDelta).toFixed(1)}°F</div>
            :<div style={{marginTop:5,fontSize:10,color:"#2a4050"}}>No ambient set — fixed thresholds only.</div>}
        </div>
        <div style={{marginBottom:14}}>
          <div style={{fontSize:10,color:"#3a6080",letterSpacing:1,marginBottom:5}}>AMBIENT MATCH DELTA (°F)</div>
          <div style={{display:"flex",gap:8}}>
            <input type="number" value={deltaDraft} onChange={e=>setDeltaDraft(e.target.value)}
              style={{flex:1,background:"#0a1828",border:"1px solid #1e3a55",borderRadius:6,color:"#c8dff0",padding:"7px 10px",fontSize:13,fontFamily:"'DM Mono',monospace",outline:"none"}}/>
            <button onClick={()=>setMatchDelta(parseFloat(deltaDraft)||8)}
              style={{background:"#1a3a5a",border:"1px solid #2a5a8a",borderRadius:6,color:"#81b4d4",fontSize:11,fontFamily:"'DM Mono',monospace",cursor:"pointer",padding:"7px 12px",letterSpacing:1}}>SET</button>
          </div>
          <div style={{marginTop:5,fontSize:10,color:"#2a4050"}}>Offline when CWS ≥ ambient − {matchDelta}°F</div>
        </div>
      </>}

      <button onClick={onSave} disabled={saving} style={{width:"100%",background:saving?"#0a1828":"#1a3a5a",border:"1px solid #2a5a8a",borderRadius:8,color:saving?"#3a6a8a":"#81b4d4",padding:"10px",fontSize:11,fontFamily:"'DM Mono',monospace",cursor:saving?"default":"pointer",letterSpacing:1}}>
        {saving?"SAVING...":"💾 SAVE SETTINGS FOR ALL VIEWERS"}
      </button>
    </div>
  );
}

export default function App() {
  const [readings,     setReadings]     = useState({});
  const [histories,    setHistories]    = useState(()=>Object.fromEntries(SENSORS.map(s=>[s.id,[]])));
  const [lastUpdate,   setLastUpdate]   = useState(new Date());
  const [apiCwsStatus, setApiCwsStatus] = useState(null);
  const [uptime,       setUptime]       = useState(null);
  const [histWindow,   setHistWindow]   = useState("24h");
  const [showHistory,  setShowHistory]  = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(false);

  const [ambientTemp,        setAmbientTemp]        = useState(null);
  const [matchDelta,         setMatchDelta]          = useState(AMBIENT_MATCH_DELTA);
  const [engState,           setEngState]            = useState("none");
  const [eta,                setEta]                 = useState("");
  const [situationFlag,      setSituationFlag]       = useState("");
  const [showHot,            setShowHot]             = useState(true);
  const [alertRecipients,    setAlertRecipients]     = useState([]);
  const [sendRecoveryEmails, setSendRecoveryEmails]  = useState(true);
  const [degradedThreshold,  setDegradedThreshold]   = useState(DEFAULT_DEGRADED);
  const [offlineThreshold,   setOfflineThreshold]    = useState(DEFAULT_OFFLINE);
  const [warnRateOfRise,     setWarnRateOfRise]      = useState(1.0);
  const [warnCooldownHours,  setWarnCooldownHours]   = useState(4);
  const [adminOpen,          setAdminOpen]           = useState(false);
  const [pwModal,            setPwModal]             = useState(false);
  const [pwDraft,            setPwDraft]             = useState("");
  const [pwError,            setPwError]             = useState(false);
  const [saving,             setSaving]              = useState(false);

  useEffect(()=>{
    fetch("/api/settings").then(r=>r.json()).then(s=>{
      if(s.showHot!==undefined)             setShowHot(s.showHot);
      if(s.engState)                        setEngState(s.engState);
      if(s.eta!==undefined)                 setEta(s.eta);
      if(s.situationFlag!==undefined)       setSituationFlag(s.situationFlag);
      if(s.alertRecipients)                 setAlertRecipients(s.alertRecipients);
      if(s.sendRecoveryEmails!==undefined)  setSendRecoveryEmails(s.sendRecoveryEmails);
      if(s.degradedThreshold)              setDegradedThreshold(s.degradedThreshold);
      if(s.offlineThreshold)               setOfflineThreshold(s.offlineThreshold);
      if(s.warnRateOfRise)                 setWarnRateOfRise(s.warnRateOfRise);
      if(s.warnCooldownHours)              setWarnCooldownHours(s.warnCooldownHours);
    }).catch(console.error);
    fetch("/api/history?window=6m").then(r=>r.json()).then(d=>{if(d.uptime)setUptime(d.uptime);}).catch(console.error);
  },[]);

  async function saveSettings() {
    setSaving(true);
    try {
      await fetch("/api/settings",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({showHot,engState,eta,situationFlag,alertRecipients,sendRecoveryEmails,
          degradedThreshold,offlineThreshold,warnRateOfRise,warnCooldownHours})});
    } catch(err){console.error(err);}
    setSaving(false);
  }

  function attemptLogin() {
    if(pwDraft===ADMIN_PASSWORD){setPwModal(false);setPwDraft("");setPwError(false);setAdminOpen(true);}
    else{setPwError(true);setPwDraft("");}
  }

  const keyBuffer=useRef("");
  useEffect(()=>{
    if(new URLSearchParams(window.location.search).get("admin")) setAdminOpen(true);
    const h=e=>{keyBuffer.current=(keyBuffer.current+e.key).slice(-5);if(keyBuffer.current==="admin")setAdminOpen(v=>!v);};
    window.addEventListener("keydown",h);
    return()=>window.removeEventListener("keydown",h);
  },[]);

  const refresh=useCallback(async()=>{
    try{
      const res=await fetch("/api/sensors");
      const data=await res.json();
      if(data.readings){
        setReadings(data.readings);
        if(data.sparklines){
          setHistories(prev=>Object.fromEntries(SENSORS.map(s=>{
            const live=data.sparklines[s.id];
            return[s.id,live?.length?live:prev[s.id]];
          })));
        }
        setApiCwsStatus(data.cwsStatus);
        setLastUpdate(new Date());
      }
    }catch(err){console.error(err);}
  },[]);

  useEffect(()=>{refresh();const id=setInterval(refresh,600000);return()=>clearInterval(id);},[refresh]);

  const cwsStatus  = apiCwsStatus||getCWSStatus(readings["CHW-S"],ambientTemp,matchDelta,offlineThreshold,degradedThreshold);
  const systemMeta = STATUS_META[cwsStatus];
  const visibleSensors = SENSORS.filter(s=>showHot||s.pipe!=="hot");

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(160deg,#060d1a 0%,#081220 50%,#06101c 100%)",color:"#c8dff0",padding:0}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700&family=DM+Mono:wght@300;400;500&display=swap');
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-track{background:#060d1a}
        ::-webkit-scrollbar-thumb{background:#1e3a5f;border-radius:2px}
        input:focus,textarea:focus{border-color:#2a5a8a !important}
      `}</style>
      <div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:0,background:"repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,20,50,0.025) 2px,rgba(0,20,50,0.025) 4px)"}}/>
      <div style={{position:"relative",zIndex:1,maxWidth:960,margin:"0 auto",padding:"24px 20px"}}>

        <div style={{marginBottom:24,borderBottom:"1px solid #1a2d45",paddingBottom:18}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:12}}>
            <div>
              <div style={{fontSize:10,color:"#2a5a7a",letterSpacing:3,marginBottom:3}}>AMERICAN TOWERS · SALT LAKE CITY</div>
              <h1 style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:30,fontWeight:700,color:"#e8f4fd",letterSpacing:1,lineHeight:1}}>HVAC INFRASTRUCTURE MONITOR</h1>
              <div style={{fontSize:10,color:"#2a5a7a",letterSpacing:2,marginTop:3}}>
                {showHot?"4-PIPE CHILLED WATER SYSTEM":"CHILLED WATER LOOP · HOT WATER SENSORS OFFLINE FOR SERVICE"}
              </div>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{display:"inline-flex",alignItems:"center",gap:8,background:systemMeta.bg,border:`1px solid ${systemMeta.border}`,borderRadius:8,padding:"8px 16px",marginBottom:6}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:systemMeta.color,boxShadow:`0 0 8px ${systemMeta.color}`,animation:cwsStatus!=="nominal"?"pulse 1.2s infinite":"none"}}/>
                <span style={{fontSize:12,fontWeight:500,color:systemMeta.color,letterSpacing:2,fontFamily:"'DM Mono',monospace"}}>{systemMeta.label}</span>
              </div>
              <div style={{fontSize:10,color:"#1e4060"}}>{fmtDate(lastUpdate)}</div>
              <div style={{fontSize:12,color:"#3a6a8a",fontFamily:"'DM Mono',monospace"}}>{fmtTime(lastUpdate)}</div>
            </div>
          </div>
          <StatusBanner cwsStatus={cwsStatus} engState={engState} eta={eta} situationFlag={situationFlag}/>
        </div>

        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(250px,1fr))",gap:14,marginBottom:22}}>
          {visibleSensors.map(s=>(
            <SensorCard key={s.id} sensor={s} reading={readings[s.id]} history={histories[s.id]}
              uptime={s.id==="CHW-S"?uptime:null} cwsStatus={cwsStatus}
              degradedT={degradedThreshold} offlineT={offlineThreshold}
              onViewHistory={()=>setShowHistory(true)} onAnalyze={()=>setShowAnalysis(true)}/>
          ))}
        </div>

        <HistoryChart window={histWindow} setWindow={setHistWindow} degradedT={degradedThreshold} offlineT={offlineThreshold}/>

        <div style={{marginBottom:22}}>
          <div style={{fontSize:10,color:"#2a5a7a",letterSpacing:3,marginBottom:10}}>DIFFERENTIAL ANALYSIS</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(175px,1fr))",gap:10}}>
            <DeltaBadge label="CHW SUPPLY → RETURN" a={readings["CHW-S"]} b={readings["CHW-R"]} colorA={SENSORS[0].color} colorB={SENSORS[1].color}/>
            {showHot&&<>
              <DeltaBadge label="HHW SUPPLY → RETURN" a={readings["HHW-S"]} b={readings["HHW-R"]} colorA={SENSORS[2].color} colorB={SENSORS[3].color}/>
              <DeltaBadge label="COLD vs HOT SUPPLY"  a={readings["CHW-S"]} b={readings["HHW-S"]} colorA={SENSORS[0].color} colorB={SENSORS[2].color}/>
              <DeltaBadge label="COLD vs HOT RETURN"  a={readings["CHW-R"]} b={readings["HHW-R"]} colorA={SENSORS[1].color} colorB={SENSORS[3].color}/>
            </>}
          </div>
        </div>

        <div style={{borderTop:"1px solid #1a2d45",paddingTop:14,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{fontSize:9,color:"#1e3a55",letterSpacing:1}}>DATA SOURCE: YOLINK · CRON COLLECTION · DISPLAY REFRESH 10MIN</div>
            <button onClick={()=>adminOpen?setAdminOpen(false):setPwModal(true)}
              title={adminOpen?"Close admin panel":"Engineering admin"}
              style={{background:"transparent",border:"1px solid #1a2d3a",borderRadius:6,padding:"4px 8px",color:adminOpen?"#4a7fa5":"#1e3a55",fontSize:14,cursor:"pointer",lineHeight:1}}>
              {adminOpen?"🔓":"🔒"}
            </button>
          </div>
          <button onClick={refresh} style={{background:"transparent",border:"1px solid #1e3a5f",borderRadius:6,padding:"6px 14px",color:"#3a6a8a",fontSize:10,fontFamily:"'DM Mono',monospace",cursor:"pointer",letterSpacing:1}}>↺ REFRESH NOW</button>
        </div>
      </div>

      {pwModal&&(
        <div onClick={e=>{if(e.target===e.currentTarget){setPwModal(false);setPwDraft("");setPwError(false);}}}
          style={{position:"fixed",inset:0,zIndex:200,background:"rgba(0,5,15,0.75)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{background:"#07111f",border:"1px solid #2a4a6a",borderRadius:14,padding:"28px 28px 24px",width:300,boxShadow:"0 12px 50px #000e",fontFamily:"'DM Mono',monospace"}}>
            <div style={{textAlign:"center",marginBottom:20}}>
              <div style={{fontSize:28,marginBottom:8}}>🔒</div>
              <div style={{fontSize:11,color:"#4a7fa5",letterSpacing:2}}>ENGINEERING ACCESS</div>
            </div>
            <input autoFocus type="password" value={pwDraft} onChange={e=>{setPwDraft(e.target.value);setPwError(false);}} onKeyDown={e=>e.key==="Enter"&&attemptLogin()} placeholder="Password"
              style={{width:"100%",background:"#0a1828",border:`1px solid ${pwError?"#EF5350":"#1e3a55"}`,borderRadius:7,color:"#c8dff0",padding:"10px 12px",fontSize:14,fontFamily:"'DM Mono',monospace",outline:"none",marginBottom:6,textAlign:"center",letterSpacing:3}}/>
            {pwError&&<div style={{fontSize:10,color:"#EF5350",textAlign:"center",marginBottom:8,letterSpacing:1}}>Incorrect password</div>}
            {!pwError&&<div style={{marginBottom:8}}/>}
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>{setPwModal(false);setPwDraft("");setPwError(false);}} style={{flex:1,background:"transparent",border:"1px solid #1e3a55",borderRadius:7,color:"#3a6a8a",padding:"9px",fontSize:11,fontFamily:"'DM Mono',monospace",cursor:"pointer",letterSpacing:1}}>CANCEL</button>
              <button onClick={attemptLogin} style={{flex:1,background:"#1a3a5a",border:"1px solid #2a5a8a",borderRadius:7,color:"#81b4d4",padding:"9px",fontSize:11,fontFamily:"'DM Mono',monospace",cursor:"pointer",letterSpacing:1}}>UNLOCK</button>
            </div>
          </div>
        </div>
      )}

      {showHistory  && <OutageHistoryModal  onClose={()=>setShowHistory(false)}  degradedT={degradedThreshold} offlineT={offlineThreshold}/>}
      {showAnalysis && <OutageAnalysisModal onClose={()=>setShowAnalysis(false)} currentReading={readings["CHW-S"]} cwsStatus={cwsStatus}/>}

      {adminOpen&&(
        <AdminPanel
          ambientTemp={ambientTemp}             setAmbientTemp={setAmbientTemp}
          matchDelta={matchDelta}               setMatchDelta={setMatchDelta}
          engState={engState}                   setEngState={setEngState}
          eta={eta}                             setEta={setEta}
          situationFlag={situationFlag}         setSituationFlag={setSituationFlag}
          showHot={showHot}                     setShowHot={setShowHot}
          alertRecipients={alertRecipients}     setAlertRecipients={setAlertRecipients}
          sendRecoveryEmails={sendRecoveryEmails} setSendRecoveryEmails={setSendRecoveryEmails}
          degradedThreshold={degradedThreshold} setDegradedThreshold={setDegradedThreshold}
          offlineThreshold={offlineThreshold}   setOfflineThreshold={setOfflineThreshold}
          warnRateOfRise={warnRateOfRise}       setWarnRateOfRise={setWarnRateOfRise}
          warnCooldownHours={warnCooldownHours} setWarnCooldownHours={setWarnCooldownHours}
          onClose={()=>setAdminOpen(false)}
          onSave={saveSettings}                 saving={saving}
        />
      )}
    </div>
  );
}