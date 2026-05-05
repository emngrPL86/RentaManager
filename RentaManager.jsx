import { useState, useEffect, useMemo, useCallback } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

const SQL_SCHEMA = `-- Ejecuta esto en Supabase → SQL Editor

create table if not exists properties (
  id uuid default gen_random_uuid() primary key,
  owner_id uuid references auth.users not null,
  name text not null,
  location text,
  type text check (type in ('long-term','short-term')) default 'long-term',
  currency text default 'EUR',
  color text default '#c9956e',
  sqm numeric,
  notes text,
  created_at timestamptz default now()
);

create table if not exists transactions (
  id uuid default gen_random_uuid() primary key,
  property_id uuid references properties(id) on delete cascade,
  type text check (type in ('income','expense')) not null,
  category text,
  amount numeric not null default 0,
  currency text default 'EUR',
  date date not null default current_date,
  description text,
  platform text,
  check_in date,
  check_out date,
  payment_status text check (payment_status in ('paid','pending','overdue')) default 'paid',
  notes text,
  created_at timestamptz default now()
);

alter table properties enable row level security;
alter table transactions enable row level security;

create policy "owners_props" on properties
  for all using (auth.uid() = owner_id);

create policy "txns_via_props" on transactions
  for all using (
    exists (
      select 1 from properties p
      where p.id = property_id and p.owner_id = auth.uid()
    )
  );`;

const PROP_COLORS = ["#c9956e","#6b9fd4","#6ec99a","#d46b6b","#a06bd4","#d4b86b"];
const CURRENCIES  = ["EUR","ALL","PLN","USD","GBP"];
const MONTHS      = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];

const INCOME_CATS = {
  "long-term":  ["Renta mensual","Electricidad","Gas","Agua","Gastos comunes","Depósito","Otros ingresos"],
  "short-term": ["Reserva Airbnb","Reserva Booking","Reserva directa","Limpieza cobrada","Otros ingresos"],
};
const EXPENSE_CATS = [
  "Utilities","Mantenimiento","Limpieza","Impuestos",
  "Comisión plataforma","Reparaciones","Seguro","Hipoteca",
  "Gestoría","Comunidad","IBI","Otros gastos",
];

const fCur = (n, cur = "EUR") => {
  try {
    return new Intl.NumberFormat("es-ES", {
      style: "currency", currency: cur, maximumFractionDigits: 0,
    }).format(n ?? 0);
  } catch {
    return `${(n ?? 0).toFixed(0)} ${cur}`;
  }
};

const fDate = (d) =>
  d ? new Date(d + "T12:00:00").toLocaleDateString("es-ES", {
    day: "2-digit", month: "short", year: "numeric",
  }) : "";

// ═══════════════════════════════════════════════════════════════════
// SUPABASE REST CLIENT
// ═══════════════════════════════════════════════════════════════════

function makeDB(url, key) {
  let tok = key, uid = null;

  const H = () => ({
    apikey: key,
    Authorization: `Bearer ${tok}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  });

  const go = async (method, table, body, qs = "") => {
    try {
      const r = await fetch(`${url}/rest/v1/${table}${qs}`, {
        method, headers: H(),
        body: body ? JSON.stringify(body) : undefined,
      });
      if (r.status === 204) return [null, null];
      const d = await r.json();
      if (!r.ok) return [null, d.message || d.msg || d.error || "Error"];
      return [Array.isArray(d) ? d : [d], null];
    } catch (e) {
      return [null, e.message];
    }
  };

  return {
    uid: () => uid,
    auth: {
      login: async (email, pw) => {
        try {
          const r = await fetch(`${url}/auth/v1/token?grant_type=password`, {
            method: "POST",
            headers: { apikey: key, "Content-Type": "application/json" },
            body: JSON.stringify({ email, password: pw }),
          });
          const d = await r.json();
          if (d.access_token) {
            tok = d.access_token; uid = d.user?.id;
            return [d.user, null];
          }
          return [null, d.error_description || d.msg || "Credenciales incorrectas"];
        } catch (e) { return [null, e.message]; }
      },
      signup: async (email, pw, name) => {
        try {
          const r = await fetch(`${url}/auth/v1/signup`, {
            method: "POST",
            headers: { apikey: key, "Content-Type": "application/json" },
            body: JSON.stringify({ email, password: pw, data: { full_name: name } }),
          });
          const d = await r.json();
          if (d.id || d.identities) return [d, null];
          return [null, d.msg || d.message || "Error al registrarse"];
        } catch (e) { return [null, e.message]; }
      },
      logout: () => { tok = key; uid = null; },
    },
    props: {
      list:   ()         => go("GET",    "properties", null, `?owner_id=eq.${uid}&order=created_at.asc`),
      create: (data)     => go("POST",   "properties", { ...data, owner_id: uid }),
      update: (id, data) => go("PATCH",  "properties", data, `?id=eq.${id}`),
      del:    (id)       => go("DELETE", "properties", null, `?id=eq.${id}`),
    },
    txns: {
      list: (ids) =>
        ids?.length
          ? go("GET", "transactions", null,
              `?property_id=in.(${ids.join(",")})&order=date.desc&limit=1000`)
          : Promise.resolve([[], null]),
      create: (data)     => go("POST",   "transactions", data),
      update: (id, data) => go("PATCH",  "transactions", data, `?id=eq.${id}`),
      del:    (id)       => go("DELETE", "transactions", null, `?id=eq.${id}`),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// BASE UI COMPONENTS
// ═══════════════════════════════════════════════════════════════════

const S = {
  input: {
    width: "100%", boxSizing: "border-box",
    background: "#080812", border: "1px solid #1c1c2e",
    borderRadius: "8px", padding: "10px 12px",
    color: "#e0e0ee", fontSize: "14px", outline: "none",
    fontFamily: "inherit", transition: "border-color 0.15s",
  },
  card: {
    background: "#10102a", border: "1px solid #1c1c2e",
    borderRadius: "14px", padding: "20px",
  },
  label: {
    display: "block", fontSize: "11px", color: "#5a5a78",
    marginBottom: "6px", textTransform: "uppercase",
    letterSpacing: "0.06em", fontWeight: "700",
  },
};

const Field = ({ label, children, half }) => (
  <div style={{ marginBottom: "14px", ...(half && { flex: 1 }) }}>
    {label && <label style={S.label}>{label}</label>}
    {children}
  </div>
);

const Inp = (props) => (
  <input
    style={S.input}
    {...props}
    onFocus={e => (e.target.style.borderColor = "#c9956e")}
    onBlur={e => (e.target.style.borderColor = "#1c1c2e")}
  />
);

const Sel = ({ children, ...props }) => (
  <select
    style={{ ...S.input, cursor: "pointer" }}
    {...props}
    onFocus={e => (e.target.style.borderColor = "#c9956e")}
    onBlur={e => (e.target.style.borderColor = "#1c1c2e")}
  >
    {children}
  </select>
);

const Btn = ({ variant = "primary", style: sx, disabled, ...props }) => {
  const base = {
    padding: "10px 18px", borderRadius: "8px", border: "none",
    cursor: disabled ? "not-allowed" : "pointer", fontSize: "13px",
    fontWeight: "700", fontFamily: "inherit",
    opacity: disabled ? 0.5 : 1, transition: "opacity 0.15s",
    letterSpacing: "0.01em",
  };
  const variants = {
    primary: { background: "#c9956e", color: "#07070e" },
    danger:  { background: "#d46b6b22", color: "#d46b6b", border: "1px solid #d46b6b44" },
    ghost:   { background: "transparent", color: "#7070a0", border: "1px solid #1c1c2e" },
    subtle:  { background: "#10102a", color: "#9090bb", border: "1px solid #1c1c2e" },
  };
  return <button disabled={disabled} style={{ ...base, ...variants[variant], ...sx }} {...props} />;
};

const Badge = ({ children, color = "#c9956e", small }) => (
  <span style={{
    background: color + "1a", color, border: `1px solid ${color}33`,
    padding: small ? "1px 7px" : "3px 9px",
    borderRadius: "20px", fontSize: small ? "10px" : "11px",
    fontWeight: "700", letterSpacing: "0.03em", whiteSpace: "nowrap",
  }}>
    {children}
  </span>
);

const Modal = ({ title, onClose, children, width = "540px" }) => (
  <div
    style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 1000, padding: "20px", backdropFilter: "blur(4px)",
    }}
    onClick={e => e.target === e.currentTarget && onClose()}
  >
    <div style={{
      background: "#0c0c1e", border: "1px solid #1c1c2e", borderRadius: "16px",
      width, maxWidth: "100%", maxHeight: "90vh", overflowY: "auto", padding: "28px",
      boxShadow: "0 25px 60px rgba(0,0,0,0.5)",
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: "22px",
      }}>
        <h3 style={{ margin: 0, color: "#e0e0ee", fontSize: "17px", fontWeight: "800" }}>{title}</h3>
        <button onClick={onClose} style={{
          background: "none", border: "none", color: "#5a5a78",
          cursor: "pointer", fontSize: "20px", lineHeight: 1, padding: "2px 6px",
        }}>✕</button>
      </div>
      {children}
    </div>
  </div>
);

const Row = ({ children, gap = 12 }) => (
  <div style={{ display: "flex", gap, marginBottom: 0 }}>{children}</div>
);

const SUPABASE_URL = "https://pzbiqvyebrycdmqlxous.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB6YmlxdnllYnJ5Y2RtcWx4b3VzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwMTI4MTUsImV4cCI6MjA5MzU4ODgxNX0.xkiqztPm-vVXXSI3-064FXfaq4kb15TctOKSgTzZ7CM";

// ═══════════════════════════════════════════════════════════════════
// AUTH SCREEN
// ═══════════════════════════════════════════════════════════════════

function AuthScreen({ db, onLogin }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setErr(""); setInfo(""); setLoading(true);
    if (mode === "login") {
      const [user, error] = await db.auth.login(email, pw);
      if (error) setErr(error);
      else onLogin(user);
    } else {
      const [, error] = await db.auth.signup(email, pw, name);
      if (error) setErr(error);
      else {
        setInfo("✉️  Revisa tu correo para confirmar la cuenta");
        setMode("login");
      }
    }
    setLoading(false);
  };

  return (
    <div style={{
      minHeight: "100vh", background: "#07070f",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: "20px", fontFamily: "'Sora', sans-serif",
    }}>
      <div style={{ width: "400px", maxWidth: "100%" }}>
        <div style={{ textAlign: "center", marginBottom: "32px" }}>
          <div style={{
            width: "52px", height: "52px", borderRadius: "14px",
            background: "linear-gradient(135deg, #c9956e, #a06b3e)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "24px", margin: "0 auto 14px",
            boxShadow: "0 8px 30px #c9956e44",
          }}>🏠</div>
          <h1 style={{ color: "#e0e0ee", fontSize: "26px", fontWeight: "900", margin: "0 0 6px", letterSpacing: "-0.03em" }}>
            RentaManager
          </h1>
          <p style={{ color: "#5a5a78", margin: 0, fontSize: "14px" }}>
            {mode === "login" ? "Bienvenido de vuelta" : "Crea tu cuenta"}
          </p>
        </div>

        <div style={S.card}>
          {mode === "signup" && (
            <Field label="Nombre completo">
              <Inp placeholder="Tu nombre" value={name} onChange={e => setName(e.target.value)} />
            </Field>
          )}
          <Field label="Email">
            <Inp type="email" placeholder="correo@ejemplo.com" value={email}
              onChange={e => setEmail(e.target.value)} />
          </Field>
          <Field label="Contraseña">
            <Inp type="password" placeholder="••••••••" value={pw}
              onChange={e => setPw(e.target.value)}
              onKeyDown={e => e.key === "Enter" && submit()} />
          </Field>

          {err  && <p style={{ color: "#d46b6b", fontSize: "13px", marginBottom: "12px" }}>{err}</p>}
          {info && <p style={{ color: "#6ec99a", fontSize: "13px", marginBottom: "12px" }}>{info}</p>}

          <Btn onClick={submit} disabled={loading} style={{ width: "100%", padding: "12px" }}>
            {loading ? "Cargando..." : mode === "login" ? "Entrar" : "Registrarme"}
          </Btn>

          <p style={{ textAlign: "center", color: "#5a5a78", fontSize: "13px", margin: "16px 0 0" }}>
            {mode === "login" ? "¿No tienes cuenta? " : "¿Ya tienes cuenta? "}
            <button onClick={() => { setMode(mode === "login" ? "signup" : "login"); setErr(""); }}
              style={{
                background: "none", border: "none", color: "#c9956e",
                cursor: "pointer", fontSize: "13px", fontWeight: "700",
              }}>
              {mode === "login" ? "Regístrate" : "Inicia sesión"}
            </button>
          </p>
        </div>


      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════

function KPICard({ label, value, icon, color, sub }) {
  return (
    <div style={{
      ...S.card, flex: 1, minWidth: "160px",
      borderTop: `3px solid ${color}`,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <p style={{ ...S.label, marginBottom: "10px" }}>{label}</p>
          <p style={{ margin: 0, fontSize: "24px", fontWeight: "900", color, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}>
            {value}
          </p>
          {sub && <p style={{ margin: "5px 0 0", fontSize: "11px", color: "#5a5a78" }}>{sub}</p>}
        </div>
        <span style={{ fontSize: "22px", opacity: 0.8 }}>{icon}</span>
      </div>
    </div>
  );
}

function DashboardView({ properties, transactions, visibleIds, setVisibleIds }) {
  const now = new Date();
  const [period, setPeriod] = useState(
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
  );

  const propMap = useMemo(() =>
    Object.fromEntries(properties.map(p => [p.id, p])), [properties]);

  const visTxns = useMemo(() =>
    transactions.filter(t => visibleIds.includes(t.property_id)), [transactions, visibleIds]);

  const periodTxns = useMemo(() =>
    visTxns.filter(t => t.date?.startsWith(period)), [visTxns, period]);

  const inc = periodTxns.filter(t => t.type === "income").reduce((s, t) => s + (+t.amount), 0);
  const exp = periodTxns.filter(t => t.type === "expense").reduce((s, t) => s + (+t.amount), 0);
  const profit = inc - exp;

  const chartData = useMemo(() => {
    return Array.from({ length: 6 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const m = visTxns.filter(t => t.date?.startsWith(key));
      return {
        name: MONTHS[d.getMonth()],
        Ingresos: m.filter(t => t.type === "income").reduce((s, t) => s + (+t.amount), 0),
        Gastos:   m.filter(t => t.type === "expense").reduce((s, t) => s + (+t.amount), 0),
      };
    });
  }, [visTxns]);

  const recent = useMemo(() => visTxns.slice(0, 12), [visTxns]);

  const toggleProp = (id) =>
    setVisibleIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const STATUS_C = { paid: "#6ec99a", pending: "#c9956e", overdue: "#d46b6b" };
  const STATUS_L = { paid: "Pagado", pending: "Pendiente", overdue: "Atrasado" };

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "22px", flexWrap: "wrap", gap: "12px" }}>
        <h2 style={{ margin: 0, color: "#e0e0ee", fontSize: "22px", fontWeight: "900", letterSpacing: "-0.02em" }}>
          Dashboard
        </h2>
        <input type="month" value={period} onChange={e => setPeriod(e.target.value)}
          style={{ ...S.input, width: "164px", padding: "8px 12px" }} />
      </div>

      {/* Property filter chips */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "22px", flexWrap: "wrap" }}>
        {properties.map(p => {
          const on = visibleIds.includes(p.id);
          return (
            <button key={p.id} onClick={() => toggleProp(p.id)} style={{
              padding: "6px 14px", borderRadius: "20px",
              border: `1.5px solid ${on ? p.color : "#1c1c2e"}`,
              background: on ? p.color + "18" : "transparent",
              color: on ? p.color : "#4a4a68",
              cursor: "pointer", fontSize: "12px", fontWeight: "700",
              fontFamily: "inherit", transition: "all 0.15s",
              letterSpacing: "0.01em",
            }}>
              ● {p.name}
            </button>
          );
        })}
        {properties.length === 0 && (
          <p style={{ color: "#5a5a78", fontSize: "13px", margin: 0 }}>
            Crea propiedades para empezar
          </p>
        )}
      </div>

      {/* KPIs */}
      <div style={{ display: "flex", gap: "14px", marginBottom: "20px", flexWrap: "wrap" }}>
        <KPICard label="Ingresos" value={fCur(inc)} icon="💰" color="#6ec99a"
          sub={`${periodTxns.filter(t => t.type === "income").length} entradas`} />
        <KPICard label="Gastos" value={fCur(exp)} icon="🧾" color="#d46b6b"
          sub={`${periodTxns.filter(t => t.type === "expense").length} salidas`} />
        <KPICard label="Beneficio neto" value={fCur(profit)} icon="📊"
          color={profit >= 0 ? "#6ec99a" : "#d46b6b"} />
      </div>

      {/* Chart */}
      <div style={{ ...S.card, marginBottom: "20px" }}>
        <h3 style={{ margin: "0 0 16px", color: "#e0e0ee", fontSize: "14px", fontWeight: "800" }}>
          Últimos 6 meses
        </h3>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData} margin={{ top: 0, right: 0, bottom: 0, left: -10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1c1c2e" vertical={false} />
            <XAxis dataKey="name" tick={{ fill: "#5a5a78", fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: "#5a5a78", fontSize: 10 }} axisLine={false} tickLine={false}
              tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v} />
            <Tooltip
              contentStyle={{ background: "#10102a", border: "1px solid #1c1c2e", borderRadius: "8px", color: "#e0e0ee", fontSize: "12px" }}
              formatter={(v, n) => [fCur(v), n]}
            />
            <Legend wrapperStyle={{ fontSize: "12px", color: "#7070a0" }} />
            <Bar dataKey="Ingresos" fill="#6ec99a" radius={[4, 4, 0, 0]} maxBarSize={40} />
            <Bar dataKey="Gastos"   fill="#d46b6b" radius={[4, 4, 0, 0]} maxBarSize={40} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Bottom grid */}
      <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
        {/* Per-property */}
        <div style={{ ...S.card, flex: "1", minWidth: "220px" }}>
          <h3 style={{ margin: "0 0 14px", color: "#e0e0ee", fontSize: "14px", fontWeight: "800" }}>
            Por propiedad
          </h3>
          {properties.filter(p => visibleIds.includes(p.id)).length === 0 && (
            <p style={{ color: "#5a5a78", fontSize: "13px", margin: 0 }}>Sin propiedades activas</p>
          )}
          {properties.filter(p => visibleIds.includes(p.id)).map(prop => {
            const pt = periodTxns.filter(t => t.property_id === prop.id);
            const pi = pt.filter(t => t.type === "income").reduce((s, t) => s + (+t.amount), 0);
            const pe = pt.filter(t => t.type === "expense").reduce((s, t) => s + (+t.amount), 0);
            const pb = pi - pe;
            return (
              <div key={prop.id} style={{ marginBottom: "12px", paddingBottom: "12px", borderBottom: "1px solid #1c1c2e" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "3px" }}>
                  <span style={{ color: prop.color, fontWeight: "800", fontSize: "13px" }}>● {prop.name}</span>
                  <span style={{ color: pb >= 0 ? "#6ec99a" : "#d46b6b", fontWeight: "900", fontSize: "14px" }}>
                    {fCur(pb, prop.currency)}
                  </span>
                </div>
                <div style={{ fontSize: "11px", color: "#5a5a78" }}>
                  ↑ {fCur(pi, prop.currency)} &nbsp;·&nbsp; ↓ {fCur(pe, prop.currency)}
                </div>
              </div>
            );
          })}
        </div>

        {/* Recent transactions */}
        <div style={{ ...S.card, flex: "2", minWidth: "300px" }}>
          <h3 style={{ margin: "0 0 14px", color: "#e0e0ee", fontSize: "14px", fontWeight: "800" }}>
            Últimas transacciones
          </h3>
          {recent.length === 0 && <p style={{ color: "#5a5a78", fontSize: "13px", margin: 0 }}>Sin transacciones</p>}
          {recent.map((t, i) => (
            <div key={t.id} style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "9px 0", borderBottom: i < recent.length - 1 ? "1px solid #1c1c2e" : "none",
              gap: "10px",
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: "#e0e0ee", fontSize: "13px", fontWeight: "600", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {t.category || t.description || "—"}
                </div>
                <div style={{ color: "#5a5a78", fontSize: "11px" }}>
                  {fDate(t.date)}
                  {propMap[t.property_id] && (
                    <span style={{ color: propMap[t.property_id].color }}> · {propMap[t.property_id].name}</span>
                  )}
                  {t.platform && ` · ${t.platform}`}
                </div>
              </div>
              <div style={{ display: "flex", gap: "6px", alignItems: "center", flexShrink: 0 }}>
                {t.payment_status && t.payment_status !== "paid" && (
                  <Badge color={STATUS_C[t.payment_status]} small>{STATUS_L[t.payment_status]}</Badge>
                )}
                <span style={{
                  color: t.type === "income" ? "#6ec99a" : "#d46b6b",
                  fontWeight: "800", fontSize: "14px",
                }}>
                  {t.type === "income" ? "+" : "−"}{fCur(t.amount, t.currency)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// PROPERTIES VIEW
// ═══════════════════════════════════════════════════════════════════

function PropertyModal({ prop, onSave, onClose }) {
  const isEdit = !!prop?.id;
  const [form, setForm] = useState({
    name: "", location: "", type: "long-term",
    currency: "EUR", color: PROP_COLORS[0], sqm: "", notes: "",
    ...prop,
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <Modal title={isEdit ? "Editar propiedad" : "Nueva propiedad"} onClose={onClose}>
      <Field label="Nombre del departamento">
        <Inp placeholder="Ej. Kraków Flat" value={form.name} onChange={e => set("name", e.target.value)} />
      </Field>
      <Field label="Ubicación">
        <Inp placeholder="Ciudad, País" value={form.location} onChange={e => set("location", e.target.value)} />
      </Field>
      <Row>
        <Field label="Tipo de renta" half>
          <Sel value={form.type} onChange={e => set("type", e.target.value)}>
            <option value="long-term">📅 Larga duración</option>
            <option value="short-term">🌍 Corta duración (Airbnb / Booking)</option>
          </Sel>
        </Field>
        <Field label="Moneda" half>
          <Sel value={form.currency} onChange={e => set("currency", e.target.value)}>
            {CURRENCIES.map(c => <option key={c}>{c}</option>)}
          </Sel>
        </Field>
      </Row>
      <Row>
        <Field label="m² (opcional)" half>
          <Inp type="number" placeholder="75" value={form.sqm} onChange={e => set("sqm", e.target.value)} />
        </Field>
        <Field label="Color identificador" half>
          <div style={{ display: "flex", gap: "8px", marginTop: "4px", flexWrap: "wrap" }}>
            {PROP_COLORS.map(c => (
              <button key={c} onClick={() => set("color", c)} style={{
                width: "28px", height: "28px", borderRadius: "50%",
                background: c, border: "none", cursor: "pointer",
                outline: form.color === c ? `3px solid ${c}` : "none",
                outlineOffset: "2px", flexShrink: 0,
              }} />
            ))}
          </div>
        </Field>
      </Row>
      <Field label="Notas">
        <Inp placeholder="Notas adicionales..." value={form.notes} onChange={e => set("notes", e.target.value)} />
      </Field>
      <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end", marginTop: "4px" }}>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn onClick={() => {
          if (!form.name.trim()) return;
          onSave(form);
        }}>Guardar propiedad</Btn>
      </div>
    </Modal>
  );
}

function PropertiesView({ properties, onAdd, onEdit, onDelete }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
        <h2 style={{ margin: 0, color: "#e0e0ee", fontSize: "22px", fontWeight: "900", letterSpacing: "-0.02em" }}>
          Propiedades
        </h2>
        <Btn onClick={onAdd}>+ Nueva propiedad</Btn>
      </div>

      {properties.length === 0 && (
        <div style={{ ...S.card, textAlign: "center", padding: "60px 20px" }}>
          <div style={{ fontSize: "36px", marginBottom: "12px" }}>🏠</div>
          <p style={{ color: "#5a5a78", fontSize: "15px", margin: "0 0 16px" }}>
            Aún no tienes propiedades registradas.
          </p>
          <Btn onClick={onAdd}>+ Agregar primera propiedad</Btn>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(270px, 1fr))", gap: "16px" }}>
        {properties.map(p => (
          <div key={p.id} style={{
            ...S.card, position: "relative",
            borderLeft: `4px solid ${p.color}`,
            transition: "transform 0.15s",
          }}>
            <div style={{ marginBottom: "12px" }}>
              <h3 style={{ margin: "0 0 4px", color: "#e0e0ee", fontSize: "17px", fontWeight: "900", letterSpacing: "-0.01em" }}>
                {p.name}
              </h3>
              {p.location && (
                <p style={{ margin: "0 0 10px", color: "#5a5a78", fontSize: "12px" }}>📍 {p.location}</p>
              )}
            </div>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "16px" }}>
              <Badge color={p.color}>{p.type === "long-term" ? "Larga duración" : "Corta duración"}</Badge>
              <Badge color="#6b9fd4">{p.currency}</Badge>
              {p.sqm && <Badge color="#7070a0">{p.sqm} m²</Badge>}
            </div>
            {p.notes && (
              <p style={{ color: "#5a5a78", fontSize: "12px", margin: "0 0 14px", lineHeight: "1.5" }}>
                {p.notes}
              </p>
            )}
            <div style={{ display: "flex", gap: "8px" }}>
              <Btn variant="subtle" style={{ flex: 1, fontSize: "12px", padding: "8px" }} onClick={() => onEdit(p)}>
                Editar
              </Btn>
              <Btn variant="danger" style={{ fontSize: "12px", padding: "8px 12px" }} onClick={() => onDelete(p)}>
                🗑
              </Btn>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// TRANSACTIONS VIEW
// ═══════════════════════════════════════════════════════════════════

function TxnModal({ txn, properties, onSave, onClose }) {
  const isEdit = !!txn?.id;
  const defaultProp = properties[0];
  const [form, setForm] = useState({
    type: "income",
    property_id: defaultProp?.id || "",
    category: "",
    amount: "",
    currency: defaultProp?.currency || "EUR",
    date: new Date().toISOString().split("T")[0],
    description: "",
    platform: "",
    check_in: "",
    check_out: "",
    payment_status: "paid",
    notes: "",
    ...txn,
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const prop = properties.find(p => p.id === form.property_id);
  const isShortTerm = prop?.type === "short-term";
  const cats = form.type === "income"
    ? (INCOME_CATS[prop?.type || "long-term"])
    : EXPENSE_CATS;

  return (
    <Modal title={isEdit ? "Editar transacción" : "Nueva transacción"} onClose={onClose}>
      <Row>
        <Field label="Tipo" half>
          <Sel value={form.type} onChange={e => { set("type", e.target.value); set("category", ""); }}>
            <option value="income">💰 Ingreso</option>
            <option value="expense">🧾 Gasto</option>
          </Sel>
        </Field>
        <Field label="Propiedad" half>
          <Sel value={form.property_id} onChange={e => {
            const p = properties.find(x => x.id === e.target.value);
            set("property_id", e.target.value);
            set("currency", p?.currency || "EUR");
          }}>
            {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Sel>
        </Field>
      </Row>
      <Row>
        <Field label="Categoría" half>
          <Sel value={form.category} onChange={e => set("category", e.target.value)}>
            <option value="">Seleccionar...</option>
            {cats.map(c => <option key={c}>{c}</option>)}
          </Sel>
        </Field>
        <Field label="Estado de pago" half>
          <Sel value={form.payment_status} onChange={e => set("payment_status", e.target.value)}>
            <option value="paid">✅ Pagado</option>
            <option value="pending">⏳ Pendiente</option>
            <option value="overdue">🔴 Atrasado</option>
          </Sel>
        </Field>
      </Row>
      <Row>
        <Field label="Importe" half>
          <Inp type="number" placeholder="0.00" min="0" step="0.01"
            value={form.amount} onChange={e => set("amount", e.target.value)} />
        </Field>
        <Field label="Moneda" half>
          <Sel value={form.currency} onChange={e => set("currency", e.target.value)}>
            {CURRENCIES.map(c => <option key={c}>{c}</option>)}
          </Sel>
        </Field>
      </Row>
      <Field label="Fecha">
        <Inp type="date" value={form.date} onChange={e => set("date", e.target.value)} />
      </Field>
      <Field label="Descripción (opcional)">
        <Inp placeholder="Detalles..." value={form.description} onChange={e => set("description", e.target.value)} />
      </Field>

      {isShortTerm && form.type === "income" && (
        <>
          <Field label="Plataforma">
            <Sel value={form.platform} onChange={e => set("platform", e.target.value)}>
              <option value="">—</option>
              <option>Airbnb</option>
              <option>Booking</option>
              <option>Directo</option>
              <option>Otro</option>
            </Sel>
          </Field>
          <Row>
            <Field label="Check-in" half>
              <Inp type="date" value={form.check_in} onChange={e => set("check_in", e.target.value)} />
            </Field>
            <Field label="Check-out" half>
              <Inp type="date" value={form.check_out} onChange={e => set("check_out", e.target.value)} />
            </Field>
          </Row>
        </>
      )}

      <Field label="Notas (opcional)">
        <Inp placeholder="Notas internas..." value={form.notes} onChange={e => set("notes", e.target.value)} />
      </Field>

      <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end", marginTop: "4px" }}>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn onClick={() => {
          if (!form.amount || !form.property_id || !form.date) return;
          onSave(form);
        }}>Guardar transacción</Btn>
      </div>
    </Modal>
  );
}

function TransactionsView({ transactions, properties, onAdd, onEdit, onDelete }) {
  const [fProp, setFProp]   = useState("all");
  const [fType, setFType]   = useState("all");
  const [fMonth, setFMonth] = useState("");
  const [fStatus, setFStatus] = useState("all");
  const [search, setSearch] = useState("");

  const propMap = useMemo(() =>
    Object.fromEntries(properties.map(p => [p.id, p])), [properties]);

  const filtered = useMemo(() => transactions.filter(t => {
    if (fProp !== "all" && t.property_id !== fProp) return false;
    if (fType !== "all" && t.type !== fType) return false;
    if (fMonth && !t.date?.startsWith(fMonth)) return false;
    if (fStatus !== "all" && t.payment_status !== fStatus) return false;
    if (search) {
      const s = search.toLowerCase();
      if (!(t.category||"").toLowerCase().includes(s) &&
          !(t.description||"").toLowerCase().includes(s) &&
          !(t.platform||"").toLowerCase().includes(s)) return false;
    }
    return true;
  }), [transactions, fProp, fType, fMonth, fStatus, search]);

  const sumInc = filtered.filter(t => t.type === "income").reduce((s, t) => s + (+t.amount), 0);
  const sumExp = filtered.filter(t => t.type === "expense").reduce((s, t) => s + (+t.amount), 0);

  const STATUS_C = { paid: "#6ec99a", pending: "#c9956e", overdue: "#d46b6b" };
  const STATUS_L = { paid: "Pagado", pending: "Pendiente", overdue: "Atrasado" };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px", flexWrap: "wrap", gap: "12px" }}>
        <h2 style={{ margin: 0, color: "#e0e0ee", fontSize: "22px", fontWeight: "900", letterSpacing: "-0.02em" }}>
          Transacciones
        </h2>
        <Btn onClick={onAdd} disabled={properties.length === 0}>+ Nueva transacción</Btn>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "14px", flexWrap: "wrap" }}>
        <Inp placeholder="🔍 Buscar..." value={search} onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: "140px", maxWidth: "200px" }} />
        <Sel value={fProp} onChange={e => setFProp(e.target.value)} style={{ flex: 1, minWidth: "140px" }}>
          <option value="all">Todas las propiedades</option>
          {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Sel>
        <Sel value={fType} onChange={e => setFType(e.target.value)} style={{ width: "150px" }}>
          <option value="all">Todos</option>
          <option value="income">💰 Ingresos</option>
          <option value="expense">🧾 Gastos</option>
        </Sel>
        <Sel value={fStatus} onChange={e => setFStatus(e.target.value)} style={{ width: "150px" }}>
          <option value="all">Todos los estados</option>
          <option value="paid">Pagado</option>
          <option value="pending">Pendiente</option>
          <option value="overdue">Atrasado</option>
        </Sel>
        <Inp type="month" value={fMonth} onChange={e => setFMonth(e.target.value)} style={{ width: "158px" }} />
      </div>

      {/* Summary bar */}
      <div style={{ display: "flex", gap: "10px", marginBottom: "14px", flexWrap: "wrap" }}>
        {[
          { label: "Ingresos filtrados", val: sumInc, color: "#6ec99a" },
          { label: "Gastos filtrados",   val: sumExp, color: "#d46b6b" },
          { label: "Resultado",          val: sumInc - sumExp, color: sumInc - sumExp >= 0 ? "#6ec99a" : "#d46b6b" },
        ].map(({ label, val, color }) => (
          <div key={label} style={{ ...S.card, padding: "10px 16px", flex: 1, minWidth: "140px" }}>
            <span style={{ color: "#5a5a78", fontSize: "11px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              {label}{" "}
            </span>
            <span style={{ color, fontWeight: "900", fontSize: "15px" }}>{fCur(val)}</span>
          </div>
        ))}
      </div>

      {/* List */}
      <div style={S.card}>
        {filtered.length === 0 && (
          <p style={{ color: "#5a5a78", textAlign: "center", padding: "48px 0", margin: 0, fontSize: "14px" }}>
            Sin transacciones con estos filtros
          </p>
        )}
        {filtered.map((t, i) => {
          const prop = propMap[t.property_id];
          const nights = t.check_in && t.check_out
            ? Math.round((new Date(t.check_out) - new Date(t.check_in)) / 86400000)
            : null;
          return (
            <div key={t.id} style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "12px 0",
              borderBottom: i < filtered.length - 1 ? "1px solid #1c1c2e" : "none",
              gap: "12px",
            }}>
              {/* Icon */}
              <div style={{
                width: "38px", height: "38px", borderRadius: "10px", flexShrink: 0,
                background: (t.type === "income" ? "#6ec99a" : "#d46b6b") + "18",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "16px",
              }}>
                {t.type === "income" ? "💰" : "🧾"}
              </div>

              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: "#e0e0ee", fontSize: "13px", fontWeight: "700", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {t.category || t.description || "Sin categoría"}
                </div>
                <div style={{ color: "#5a5a78", fontSize: "11px", marginTop: "2px" }}>
                  {fDate(t.date)}
                  {prop && <span style={{ color: prop.color }}> · {prop.name}</span>}
                  {t.platform && <span> · {t.platform}</span>}
                  {nights !== null && <span> · {nights} noches</span>}
                  {t.description && t.category && <span> · {t.description}</span>}
                </div>
              </div>

              {/* Right side */}
              <div style={{ display: "flex", gap: "8px", alignItems: "center", flexShrink: 0 }}>
                <Badge color={STATUS_C[t.payment_status] || "#5a5a78"} small>
                  {STATUS_L[t.payment_status] || t.payment_status}
                </Badge>
                <span style={{
                  color: t.type === "income" ? "#6ec99a" : "#d46b6b",
                  fontWeight: "900", fontSize: "14px", minWidth: "85px", textAlign: "right",
                }}>
                  {t.type === "income" ? "+" : "−"}{fCur(t.amount, t.currency)}
                </span>
                <button onClick={() => onEdit(t)} title="Editar"
                  style={{ background: "none", border: "none", color: "#5a5a78", cursor: "pointer", padding: "4px", fontSize: "14px" }}>
                  ✏️
                </button>
                <button onClick={() => onDelete(t)} title="Eliminar"
                  style={{ background: "none", border: "none", color: "#d46b6b88", cursor: "pointer", padding: "4px", fontSize: "14px" }}>
                  🗑
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SIDEBAR
// ═══════════════════════════════════════════════════════════════════

const NAV = [
  { id: "dashboard",    label: "Dashboard",       icon: "📊" },
  { id: "properties",   label: "Propiedades",     icon: "🏠" },
  { id: "transactions", label: "Transacciones",   icon: "💳" },
];

function Sidebar({ view, setView, user, onLogout, collapsed, setCollapsed }) {
  return (
    <div style={{
      width: collapsed ? "62px" : "210px",
      minHeight: "100vh", background: "#0c0c1e",
      borderRight: "1px solid #1c1c2e",
      display: "flex", flexDirection: "column",
      transition: "width 0.2s ease", flexShrink: 0, position: "relative",
    }}>
      {/* Logo */}
      <div style={{
        padding: collapsed ? "18px 0" : "18px 16px",
        borderBottom: "1px solid #1c1c2e",
        display: "flex", alignItems: "center",
        justifyContent: collapsed ? "center" : "space-between",
      }}>
        {!collapsed && (
          <div>
            <div style={{ color: "#c9956e", fontWeight: "900", fontSize: "14px", letterSpacing: "-0.02em" }}>
              🏠 RentaManager
            </div>
          </div>
        )}
        <button onClick={() => setCollapsed(c => !c)} style={{
          background: "none", border: "none", color: "#3a3a58",
          cursor: "pointer", fontSize: "16px", padding: "2px", lineHeight: 1,
        }} title={collapsed ? "Expandir" : "Colapsar"}>
          {collapsed ? "▶" : "◀"}
        </button>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: "10px 8px" }}>
        {NAV.map(item => {
          const active = view === item.id;
          return (
            <button key={item.id} onClick={() => setView(item.id)} style={{
              display: "flex", alignItems: "center", gap: "10px",
              width: "100%", padding: "10px 10px", borderRadius: "8px",
              border: "none", cursor: "pointer", fontFamily: "inherit",
              background: active ? "#c9956e18" : "transparent",
              color: active ? "#c9956e" : "#4a4a68",
              fontSize: "13px", fontWeight: active ? "800" : "500",
              marginBottom: "2px", textAlign: "left", transition: "all 0.15s",
              justifyContent: collapsed ? "center" : "flex-start",
            }} title={collapsed ? item.label : ""}>
              <span style={{ fontSize: "17px", flexShrink: 0 }}>{item.icon}</span>
              {!collapsed && <span>{item.label}</span>}
            </button>
          );
        })}
      </nav>

      {/* User */}
      <div style={{ padding: "10px 8px", borderTop: "1px solid #1c1c2e" }}>
        {!collapsed && user && (
          <div style={{ padding: "8px 10px", marginBottom: "4px" }}>
            <div style={{ color: "#e0e0ee", fontSize: "12px", fontWeight: "700", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {user.user_metadata?.full_name || user.email?.split("@")[0]}
            </div>
            <div style={{ color: "#3a3a58", fontSize: "10px", overflow: "hidden", textOverflow: "ellipsis" }}>
              {user.email}
            </div>
          </div>
        )}
        <button onClick={onLogout} title="Cerrar sesión" style={{
          display: "flex", alignItems: "center", gap: "10px",
          width: "100%", padding: "10px 10px", borderRadius: "8px",
          border: "none", cursor: "pointer", fontFamily: "inherit",
          background: "transparent", color: "#3a3a58",
          fontSize: "13px", textAlign: "left", transition: "all 0.15s",
          justifyContent: collapsed ? "center" : "flex-start",
        }}>
          <span style={{ fontSize: "17px" }}>🚪</span>
          {!collapsed && <span>Salir</span>}
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════

function MainApp({ db, user, onLogout }) {
  const [view, setView]         = useState("dashboard");
  const [props, setProps]       = useState([]);
  const [txns, setTxns]         = useState([]);
  const [visibleIds, setVisibleIds] = useState([]);
  const [collapsed, setCollapsed] = useState(false);
  const [loading, setLoading]   = useState(true);

  const [propModal, setPropModal] = useState(null);
  const [txnModal, setTxnModal]   = useState(null);
  const [delItem, setDelItem]     = useState(null);
  const [saving, setSaving]       = useState(false);

  const loadAll = useCallback(async () => {
    const [propList] = await db.props.list();
    const pl = propList || [];
    setProps(pl);
    setVisibleIds(prev => {
      const allIds = pl.map(p => p.id);
      const filtered = prev.filter(id => allIds.includes(id));
      return filtered.length > 0 ? filtered : allIds;
    });
    if (pl.length > 0) {
      const [tList] = await db.txns.list(pl.map(p => p.id));
      setTxns(tList || []);
    } else {
      setTxns([]);
    }
    setLoading(false);
  }, [db]);

  useEffect(() => { loadAll(); }, [loadAll]);
  useEffect(() => {
    const t = setInterval(loadAll, 30000);
    return () => clearInterval(t);
  }, [loadAll]);

  // CRUD
  const saveProp = async (form) => {
    setSaving(true);
    const data = {
      name: form.name.trim(), location: form.location,
      type: form.type, currency: form.currency,
      color: form.color, sqm: form.sqm ? +form.sqm : null,
      notes: form.notes,
    };
    if (form.id) await db.props.update(form.id, data);
    else await db.props.create(data);
    setPropModal(null);
    await loadAll();
    setSaving(false);
  };

  const deleteProp = async () => {
    if (!delItem) return;
    await db.props.del(delItem.id);
    setDelItem(null);
    await loadAll();
  };

  const saveTxn = async (form) => {
    setSaving(true);
    const data = {
      property_id: form.property_id,
      type: form.type, category: form.category || null,
      amount: +form.amount, currency: form.currency,
      date: form.date, description: form.description || null,
      platform: form.platform || null,
      check_in: form.check_in || null, check_out: form.check_out || null,
      payment_status: form.payment_status,
      notes: form.notes || null,
    };
    if (form.id) await db.txns.update(form.id, data);
    else await db.txns.create(data);
    setTxnModal(null);
    await loadAll();
    setSaving(false);
  };

  const deleteTxn = async () => {
    if (!delItem) return;
    await db.txns.del(delItem.id);
    setDelItem(null);
    await loadAll();
  };

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "#07070f", fontFamily: "'Sora', sans-serif" }}>
      <Sidebar
        view={view} setView={setView}
        user={user} onLogout={onLogout}
        collapsed={collapsed} setCollapsed={setCollapsed}
      />

      <div style={{ flex: 1, padding: "28px 32px", overflowY: "auto", minWidth: 0 }}>
        {loading ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "200px", color: "#3a3a58", fontSize: "14px" }}>
            Cargando...
          </div>
        ) : (
          <>
            {view === "dashboard" && (
              <DashboardView
                properties={props} transactions={txns}
                visibleIds={visibleIds} setVisibleIds={setVisibleIds}
              />
            )}
            {view === "properties" && (
              <PropertiesView
                properties={props}
                onAdd={() => setPropModal({})}
                onEdit={p => setPropModal(p)}
                onDelete={p => setDelItem({ ...p, _type: "prop" })}
              />
            )}
            {view === "transactions" && (
              <TransactionsView
                transactions={txns} properties={props}
                onAdd={() => {
                  if (props.length === 0) { setView("properties"); } else { setTxnModal({}); }
                }}
                onEdit={t => setTxnModal(t)}
                onDelete={t => setDelItem({ ...t, _type: "txn" })}
              />
            )}
          </>
        )}
      </div>

      {/* Property modal */}
      {propModal !== null && (
        <PropertyModal prop={propModal} onSave={saveProp} onClose={() => setPropModal(null)} />
      )}

      {/* Transaction modal */}
      {txnModal !== null && props.length > 0 && (
        <TxnModal txn={txnModal} properties={props} onSave={saveTxn} onClose={() => setTxnModal(null)} />
      )}

      {/* Delete confirm */}
      {delItem && (
        <Modal title="Confirmar eliminación" onClose={() => setDelItem(null)} width="400px">
          <p style={{ color: "#7070a0", marginTop: 0, lineHeight: "1.6", fontSize: "14px" }}>
            ¿Eliminar <strong style={{ color: "#e0e0ee" }}>
              {delItem.name || delItem.category || "esta transacción"}
            </strong>?
            {delItem._type === "prop" && (
              <span style={{ color: "#d46b6b" }}> Esto eliminará también todas sus transacciones.</span>
            )}
          </p>
          <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
            <Btn variant="ghost" onClick={() => setDelItem(null)}>Cancelar</Btn>
            <Btn variant="danger" onClick={delItem._type === "prop" ? deleteProp : deleteTxn}>
              Eliminar definitivamente
            </Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ROOT
// ═══════════════════════════════════════════════════════════════════

export default function App() {
  const [screen, setScreen] = useState("auth");
  const [user, setUser]     = useState(null);
  const [db]                = useState(() => makeDB(SUPABASE_URL, SUPABASE_KEY));

  useEffect(() => {
    if (!document.getElementById("rm-font")) {
      const link = document.createElement("link");
      link.id = "rm-font";
      link.rel = "stylesheet";
      link.href = "https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800;900&display=swap";
      document.head.appendChild(link);
    }
  }, []);

  const handleLogin = (u) => {
    setUser(u);
    setScreen("app");
  };

  const handleLogout = () => {
    db.auth.logout();
    setUser(null);
    setScreen("auth");
  };

  if (screen === "auth") return <AuthScreen db={db} onLogin={handleLogin} />;
  return <MainApp db={db} user={user} onLogout={handleLogout} />;
}
