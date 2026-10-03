import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { io } from "socket.io-client";
import CommunityPage from "./Community.jsx";
import {
  ArrowRight,
  BadgeCheck,
  BarChart3,
  Bell,
  Building2,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Edit3,
  Eye,
  EyeOff,
  File,
  FileArchive,
  FileSpreadsheet,
  FileText,
  Globe2,
  Image,
  LayoutDashboard,
  LockKeyhole,
  Mail,
  Menu,
  MessageCircle,
  Mic,
  MicOff,
  Package,
  PackageCheck,
  Paperclip,
  Pencil,
  Phone,
  Plus,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Tag,
  Trash2,
  Truck,
  Users,
  X,
} from "lucide-react";
import {
  CUBIC_FEET_PER_CBM,
  DEFAULT_AIR_DIMENSIONAL_DIVISOR,
  DEFAULT_SEA_VOLUMETRIC_FACTOR_KG_PER_CBM,
  calculateCbmMetrics,
} from "./cbmCalculator.js";
import "./styles.css";

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? "/api" : "https://server.vendorwoo.com/api");
const API_ORIGIN = API_URL.replace(/\/api\/?$/, "");
const GOOGLE_CLIENT_ID = String(import.meta.env.VITE_GOOGLE_CLIENT_ID || "").trim();
let googleIdentityScriptPromise;
const loadGoogleIdentityServices = () => {
  if (window.google?.accounts?.id) return Promise.resolve(window.google);
  if (googleIdentityScriptPromise) return googleIdentityScriptPromise;
  googleIdentityScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(window.google), { once: true });
      existing.addEventListener("error", () => reject(new Error("Google authentication could not be loaded")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(window.google);
    script.onerror = () => reject(new Error("Google authentication could not be loaded"));
    document.head.appendChild(script);
  });
  return googleIdentityScriptPromise;
};
function GoogleAuthButton({ intent, disabled, onCredential, onError }) {
  const buttonRef = useRef(null);
  const credentialRef = useRef(onCredential);
  const errorRef = useRef(onError);
  credentialRef.current = onCredential;
  errorRef.current = onError;
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || disabled || !buttonRef.current) return undefined;
    let active = true;
    loadGoogleIdentityServices()
      .then((google) => {
        if (!active || !buttonRef.current) return;
        buttonRef.current.replaceChildren();
        google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: (response) => credentialRef.current(response.credential) });
        google.accounts.id.renderButton(buttonRef.current, { type: "standard", theme: "outline", size: "large", text: intent === "signup" ? "signup_with" : "signin_with", shape: "rectangular", width: 320 });
      })
      .catch((error) => {
        if (active) errorRef.current(error.message);
      });
    return () => { active = false; };
  }, [disabled, intent]);
  if (!GOOGLE_CLIENT_ID) return null;
  return <div className="customer-google-auth" ref={buttonRef} aria-label={intent === "signup" ? "Sign up with Google" : "Sign in with Google"} />;
}
const API_REQUEST_TIMEOUT_MS = 8000;
const API_RETRY_DELAYS = [400, 1000];
const isRetryableStatus = (status) => [408, 425, 429, 500, 502, 503, 504].includes(status);
const requestPath = (url) => {
  try {
    return new URL(url, window.location.origin).pathname;
  } catch {
    return "unknown";
  }
};
const fetchWithRecovery = async (url, options = {}) => {
  const method = String(options.method || "GET").toUpperCase();
  const retryableMethod = ["GET", "HEAD", "OPTIONS"].includes(method);
  let lastError;
  for (let attempt = 0; attempt <= API_RETRY_DELAYS.length; attempt += 1) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (retryableMethod && isRetryableStatus(response.status) && attempt < API_RETRY_DELAYS.length) {
        await response.arrayBuffer();
        const delay = API_RETRY_DELAYS[attempt];
        console.warn(`[api] retry path=${requestPath(url)} status=${response.status} attempt=${attempt + 1} delayMs=${delay}`);
        await new Promise((resolve) => window.setTimeout(resolve, delay));
        continue;
      }
      if (retryableMethod && isRetryableStatus(response.status)) console.error(`[api] final_failure path=${requestPath(url)} status=${response.status} attempts=${attempt + 1}`);
      return response;
    } catch (error) {
      lastError = error;
      const retryableError = error?.name === "AbortError" || error instanceof TypeError;
      if (!retryableMethod || !retryableError || attempt === API_RETRY_DELAYS.length) {
        console.error(`[api] final_failure path=${requestPath(url)} reason=${error?.name || "unknown"} attempts=${attempt + 1}`);
        throw error;
      }
      const delay = API_RETRY_DELAYS[attempt];
      console.warn(`[api] retry path=${requestPath(url)} reason=${error.name} attempt=${attempt + 1} delayMs=${delay}`);
      await new Promise((resolve) => window.setTimeout(resolve, delay));
    } finally {
      window.clearTimeout(timeout);
    }
  }
  throw lastError;
};
const getVoiceRecordingMimeType = () => {
  if (typeof MediaRecorder === "undefined") return "";
  return ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"]
    .find((type) => MediaRecorder.isTypeSupported(type)) || "";
};
const getVoiceRecordingExtension = (mimeType) => mimeType.includes("ogg") ? "ogg" : "webm";
function Loader() {
  return (
    <div className="loader">
      <div className="justify-content-center jimu-primary-loading" />
    </div>
  );
}
const navigateTo = (path) => {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
};
const dashboardRoutes = {
  Overview: "/dashboard",
  Products: "/dashboard/product",
  Categories: "/dashboard/category",
  Customers: "/dashboard/customer",
  Vendors: "/dashboard/vendor",
  Employees: "/dashboard/employee",
  Inquiries: "/dashboard/inquiry",
  "Contact Requests": "/dashboard/contact-requests",
  Messages: "/dashboard/message",
  Notifications: "/dashboard/notifications",
  Profile: "/dashboard/profile",
  Settings: "/dashboard/setting",
};
const dashboardSections = {
  product: "Products",
  category: "Categories",
  customer: "Customers",
  customers: "Customers",
  vendor: "Vendors",
  vendors: "Vendors",
  employee: "Employees",
  employees: "Employees",
  inquiry: "Inquiries",
  "contact-requests": "Contact Requests",
  message: "Messages",
  notifications: "Notifications",
  profile: "Profile",
  setting: "Settings",
};
const dashboardSectionFromPath = (path) =>
  dashboardSections[path.replace(/^\/dashboard\/?/, "").replace(/\/$/, "")] ||
  "Overview";
const dashboardPath = (section) =>
  dashboardRoutes[section] || dashboardRoutes.Overview;
const authToken = () => localStorage.getItem("omni-dashboard-token") || "";
const authHeaders = () => {
  const token = authToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};
const getBrowserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const getCurrentGreeting = (fullName = "User", now = new Date()) => {
  const timeZone = getBrowserTimeZone();
  const localNow = new Date(now.toLocaleString("en-US", { timeZone }));
  const hour = localNow.getHours();
  const label = hour >= 5 && hour < 12
    ? "Good morning"
    : hour >= 12 && hour < 17
      ? "Good afternoon"
      : hour >= 17 && hour < 21
        ? "Good evening"
        : "Good night";
  return `${label}, ${fullName}.`;
};
const useCurrentGreeting = (fullName = "User") => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const updateNow = () => setNow(new Date());
    const timer = setInterval(updateNow, 60000);
    updateNow();
    return () => clearInterval(timer);
  }, [fullName]);
  return getCurrentGreeting(fullName, now);
};
const formatMarketplaceDateTime = (value, options = {}) => {
  if (!value) return options.fallback ?? "Now";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return options.fallback ?? "Now";
  const formatter = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: options.timeZone || getBrowserTimeZone(),
    ...options,
  });
  return formatter.format(date);
};
const logout = () => {
  localStorage.removeItem("omni-dashboard-token");
  localStorage.removeItem("omni-dashboard-user");
  window.location.href = "/dashboard";
};
const storedUser = () => {
  try {
    return JSON.parse(localStorage.getItem("omni-dashboard-user") || "{}");
  } catch {
    return {};
  }
};
function SidebarAccount() {
  const user = storedUser();
  return (
    <div className="sidebar-account">
      <div className="sidebar-account-user">
        <span className="sidebar-account-avatar">
          {(user.fullName || "User").slice(0, 2).toUpperCase()}
        </span>
        <span>{user.fullName || "User"}</span>
      </div>
      <button type="button" className="sidebar-logout" onClick={logout}>
        Logout
      </button>
    </div>
  );
}
function DashboardTopbar({ title, notificationCount = 0, onNotifications, onMenuToggle, mobileNavOpen }) {
  const user = storedUser();
  const fullName = user.fullName || "User";
  const initials = (fullName)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const avatarImage = user.avatar || user.profileImage || user.image || user.photoUrl || user.avatarUrl || "";
  return (
    <div className="dashboard-topbar">
      <button
        type="button"
        className="dashboard-mobile-menu-button"
        aria-label={mobileNavOpen ? "Close dashboard navigation" : "Open dashboard navigation"}
        aria-expanded={mobileNavOpen}
        onClick={onMenuToggle}
      >
        {mobileNavOpen ? <X size={20} /> : <Menu size={20} />}
      </button>
      <div>
        <span className="breadcrumb">Workspace / </span>
        <strong>{title}</strong>
      </div>
      <div className="topbar-user">
        <button className="icon-button notification-button" aria-label="Notifications" onClick={onNotifications}>
          <Bell size={15} />
          {notificationCount > 0 ? <b className="notification-badge">{notificationCount > 99 ? "99+" : notificationCount}</b> : null}
        </button>
        <span className="avatar" aria-label={fullName}>
          {avatarImage ? <img src={avatarImage} alt={fullName} /> : initials}
        </span>
        <span>{fullName}</span>
      </div>
    </div>
  );
}
function PasswordField({
  name,
  value,
  onChange,
  placeholder,
  autoComplete,
  required = true,
}) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="password-field">
      <input
        required={required}
        name={name}
        type={visible ? "text" : "password"}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete={autoComplete}
      />
      <button
        type="button"
        className="password-toggle"
        onClick={() => setVisible((current) => !current)}
        aria-label={visible ? "Hide password" : "Show password"}
      >
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </span>
  );
}
function DashboardPasswordReset({ onBack }) {
  const [step, setStep] = useState("email");
  const [emailAddress, setEmailAddress] = useState("");
  const [resetId, setResetId] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setError("");
    if (step === "password" && newPassword !== confirmNewPassword) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const endpoint = step === "email" ? "request" : step === "code" ? "verify" : "reset";
      const body = step === "email"
        ? { emailAddress }
        : step === "code"
          ? { resetId, code: verificationCode }
          : { resetId, password: newPassword, confirmPassword: confirmNewPassword };
      const response = await fetch(`${API_URL}/auth/forgot-password/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await parseResponse(response);
      if (step === "email") {
        setResetId(result.resetId);
        setStep("code");
      } else if (step === "code") {
        setStep("password");
      } else {
        onBack("Your password has been updated. You can now sign in.");
      }
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <form className="contact-modal category-form login-form" onSubmit={submit} noValidate>
      <div className="modal-heading">
        <div>
          <div className="eyebrow">VENDOR WOO DASHBOARD</div>
          <h1>{step === "email" ? "Forgot Password?" : step === "code" ? "Enter Your Code" : "New Password"}</h1>
          <p>
            {step === "email"
              ? "Enter your email address to receive a verification code."
              : step === "code"
                ? `Enter the code sent to ${emailAddress}.`
                : "Choose a new password for your account."}
          </p>
        </div>
      </div>
      {step === "email" && (
        <label>
          Email Address
          <input
            required
            type="email"
            value={emailAddress}
            onChange={(event) => setEmailAddress(event.target.value)}
            placeholder="Enter your email address"
            autoComplete="email"
          />
        </label>
      )}
      {step === "code" && (
        <label>
          Verification Code
          <input
            required
            inputMode="numeric"
            maxLength={6}
            value={verificationCode}
            onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="Enter your 6-digit code"
            autoComplete="one-time-code"
          />
        </label>
      )}
      {step === "password" && (
        <>
          <label>
            New Password
            <PasswordField name="newPassword" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="Enter your new password" autoComplete="new-password" />
          </label>
          <label>
            Confirm Password
            <PasswordField name="confirmNewPassword" value={confirmNewPassword} onChange={(event) => setConfirmNewPassword(event.target.value)} placeholder="Confirm your new password" autoComplete="new-password" />
          </label>
        </>
      )}
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="button quiet" onClick={() => onBack("")}>Back to Sign In</button>
        <button className={`button primary${submitting ? " button-loading" : ""}`} type="submit" disabled={submitting}>
          {submitting ? <Loader /> : <>{step === "email" ? "Send Code" : step === "code" ? "Verify Code" : "Update Password"} <ArrowRight size={16} /></>}
        </button>
      </div>
    </form>
  );
}
function LoginPage({ onLogin }) {
  const [emailAddress, setEmailAddress] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resettingPassword, setResettingPassword] = useState(false);
  const [success, setSuccess] = useState("");
  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const response = await fetchWithRecovery(`${API_URL}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailAddress, password }),
      });
      const result = await parseResponse(response);
      localStorage.setItem("omni-dashboard-token", result.token);
      localStorage.setItem("omni-dashboard-user", JSON.stringify(result.employee));
      onLogin(result.employee);
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSubmitting(false);
    }
  };
  if (resettingPassword) {
    return (
      <main className="login-page">
        <DashboardPasswordReset onBack={(message) => { setResettingPassword(false); setSuccess(message); }} />
      </main>
    );
  }
  return (
    <main className="login-page">
      <form
        className="contact-modal category-form login-form"
        onSubmit={submit}
        noValidate
      >
        <div className="modal-heading">
          <div>
            <div className="eyebrow">VENDOR WOO DASHBOARD</div>
            <h1>Welcome back</h1>
            <p>Sign in with your employee account to continue.</p>
          </div>
        </div>
        {success && <div className="form-success" role="status">{success}</div>}
        <label>
          Email Address
          <input
            required
            type="email"
            value={emailAddress}
            onChange={(event) => setEmailAddress(event.target.value)}
            placeholder="Enter your email address"
            autoComplete="username"
          />
        </label>
        <label>
          Password
          <PasswordField
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Enter your password"
            autoComplete="current-password"
          />
        </label>
        <button type="button" className="auth-forgot-link signin-forgot-link" onClick={() => { setError(""); setSuccess(""); setResettingPassword(true); }}>
          Forgot Password?
        </button>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <button className={`button primary${submitting ? " button-loading" : ""}`} type="submit" disabled={submitting}>
          {submitting ? <Loader /> : <>Sign in <ArrowRight size={16} /></>}
        </button>
      </form>
    </main>
  );
}
const mediaUrl = (image) => {
  if (!image) return "";
  if (/^https?:\/\//i.test(image)) {
    try {
      const parsed = new URL(image);
      if (parsed.pathname.startsWith("/uploads/")) {
        return `${API_ORIGIN}${parsed.pathname}${parsed.search}`;
      }
    } catch {
      return image;
    }
    return image;
  }
  const normalized = image.startsWith("/") ? image : `/${image}`;
  return normalized.startsWith("/uploads/")
    ? `${API_ORIGIN}${normalized}`
    : normalized;
};
const clientCache = new Map();
const invalidateClientCache = (prefix) => {
  for (const key of clientCache.keys())
    if (key.startsWith(prefix)) clientCache.delete(key);
};
const parseResponse = async (response) => {
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { message: text };
  }
  if (!response.ok) {
    const error = new Error(
      body?.message || `Request failed with status ${response.status}`,
    );
    error.status = response.status;
    error.details = body;
    throw error;
  }
  return body;
};
const getJson = (path, ttl = 15000) => {
  const now = Date.now();
  const cached = clientCache.get(path);
  if (cached?.data && cached.expiresAt > now)
    return Promise.resolve(cached.data);
  if (cached?.promise) return cached.promise;
  const cacheEntry = {};
  const promise = fetchWithRecovery(`${API_URL}${path}`, { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error("Request failed");
      return response.json();
    })
    .then((data) => {
      if (clientCache.get(path) === cacheEntry)
        clientCache.set(path, { data, expiresAt: Date.now() + ttl });
      return data;
    })
    .finally(() => {
      if (clientCache.get(path) === cacheEntry) clientCache.delete(path);
    });
  cacheEntry.promise = promise;
  clientCache.set(path, cacheEntry);
  return promise;
};
const prefetchJson = (path, ttl) => {
  getJson(path, ttl).catch(() => { });
};
const formatPrice = (value) => {
  const numericValue = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(numericValue)
    ? `$${numericValue.toFixed(2)}`
    : "$0.00";
};
const formatMoqRange = (tier) => {
  const minimum = Number(tier?.moqMin);
  const maximum = Number(tier?.moqMax);
  if (!Number.isFinite(minimum)) return "Quantity unavailable";
  if (!Number.isFinite(maximum) || maximum <= 0)
    return `${minimum.toLocaleString()}+ Units`;
  return `${minimum.toLocaleString()}-${maximum.toLocaleString()} Units`;
};
const productTiers = (product) =>
  product?.priceTiers?.length
    ? product.priceTiers
    : product?.tiers?.length
      ? product.tiers
      : [];
const catalogChangeKey = "omni-catalog-change";
const catalogSyncChannel =
  typeof BroadcastChannel === "undefined"
    ? null
    : new BroadcastChannel("omni-catalog-sync");
const messageSyncKey = "omni-message-sync";
const messageSyncChannel =
  typeof BroadcastChannel === "undefined"
    ? null
    : new BroadcastChannel("omni-message-sync");
const notifyCatalogChange = () => {
  const message = String(Date.now());
  localStorage.setItem(catalogChangeKey, message);
  catalogSyncChannel?.postMessage(message);
};
const notifyMessagesChange = () => {
  const message = String(Date.now());
  localStorage.setItem(messageSyncKey, message);
  messageSyncChannel?.postMessage(message);
};
const products = [];
const voiceWaveformBars = [
  0.25, 0.45, 0.68, 0.36, 0.82, 0.54, 0.92, 0.4, 0.7, 0.33, 0.88, 0.58, 0.76,
  0.3, 0.62, 0.41, 0.8, 0.48, 0.9, 0.35, 0.66, 0.44, 0.78, 0.31, 0.57, 0.52,
  0.74, 0.28, 0.64, 0.43,
];
const slides = [
  {
    eyebrow: "GLOBAL SOURCING, REFINED",
    title: "Build your next product line with confidence.",
    text: "A considered marketplace for teams that value reliable suppliers, clear terms, and better business.",
    image: "/1.jpeg",
  },
  {
    eyebrow: "MADE FOR MOMENTUM",
    title: "From first inquiry to finished shipment.",
    text: "Keep every sourcing decision focused, visible, and ready for scale.",
    image: "/3.jpeg",
  },
  {
    eyebrow: "PARTNERS YOU CAN TRUST",
    title: "Find capability, not just inventory.",
    text: "Compare verified suppliers and build relationships that last beyond a single order.",
    image: "/4.jpeg",
  },
  {
    eyebrow: "YOUR GLOBAL ADVANTAGE",
    title: "Source with a sharper point of view.",
    text: "A modern B2B experience designed around how ambitious teams actually buy.",
    image: "/5.jpeg",
  },
];

function CustomerPasswordField({ value, onChange, placeholder, name }) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="password-field">
      <input
        name={name}
        required
        type={visible ? "text" : "password"}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
      />
      <button
        type="button"
        className="password-toggle"
        onClick={() => setVisible((current) => !current)}
        aria-label={visible ? "Hide password" : "Show password"}
      >
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </span>
  );
}
function CustomerAuthModal({ mode, onClose, onAuthenticated, onSwitchMode }) {
  const [authMode, setAuthMode] = useState(mode);
  const signup = authMode === "signup";
  const signupCode = authMode === "signup-code";
  const googlePhone = authMode === "google-phone";
  const signin = authMode === "signin";
  const forgotEmail = authMode === "forgot-email";
  const forgotCode = authMode === "forgot-code";
  const forgotPassword = authMode === "forgot-password";
  const [form, setForm] = useState({
    customerName: "",
    phoneNumber: "",
    emailAddress: "",
    password: "",
    confirmPassword: "",
    agreedTerms: false,
    resetId: "",
    signupId: "",
    verificationCode: "",
    newPassword: "",
    confirmNewPassword: "",
  });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [googleSignupToken, setGoogleSignupToken] = useState("");
  useEffect(() => setAuthMode(mode), [mode]);
  const update = (field, value) =>
    setForm((current) => ({ ...current, [field]: value }));
  const handleGoogleCredential = async (credential, intent) => {
    setError("");
    setSuccess("");
    setSubmitting(true);
    try {
      const response = await fetchWithRecovery(`${API_URL}/customer-auth/google`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential, intent }),
      });
      const result = await parseResponse(response);
      if (result.requiresPhone) {
        setGoogleSignupToken(result.googleSignupToken);
        setForm((current) => ({ ...current, customerName: result.customer?.customerName || "", emailAddress: result.customer?.emailAddress || "", phoneNumber: "", agreedTerms: false }));
        setAuthMode("google-phone");
        return;
      }
      onAuthenticated(result.customer);
      onClose();
    } catch (googleError) {
      setError(googleError.message || "Google authentication could not be completed.");
    } finally {
      setSubmitting(false);
    }
  };
  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setSuccess("");
    if ((signup || googlePhone) && !form.agreedTerms) {
      setError("Please agree to the Terms and Conditions.");
      return;
    }
    if (signup && form.password !== form.confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (googlePhone && !/^\+?[\d\s().-]{7,20}$/.test(form.phoneNumber.trim())) {
      setError("Enter a valid phone number.");
      return;
    }
    setSubmitting(true);
    try {
      const resetEndpoint = forgotEmail
        ? "request"
        : forgotCode
          ? "verify"
          : "reset";
      const endpoint = googlePhone
        ? `${API_URL}/customer-auth/google/complete`
        : signup
          ? `${API_URL}/customer-auth/signup/request`
          : signupCode
            ? `${API_URL}/customer-auth/signup/verify`
            : forgotEmail || forgotCode || forgotPassword
              ? `${API_URL}/customer-auth/forgot-password/${resetEndpoint}`
              : `${API_URL}/customer-auth/${signup ? "signup" : "login"}`;
      const body = googlePhone
        ? { googleSignupToken, phoneNumber: form.phoneNumber, agreedTerms: form.agreedTerms }
        : signup
          ? form
          : signupCode
            ? { signupId: form.signupId, code: form.verificationCode }
            : forgotEmail
              ? { emailAddress: form.emailAddress }
              : forgotCode
                ? { resetId: form.resetId, code: form.verificationCode }
                : forgotPassword
                  ? { resetId: form.resetId, password: form.newPassword, confirmPassword: form.confirmNewPassword }
                  : signup
                    ? form
                    : { emailAddress: form.emailAddress, password: form.password };
      const response = await fetchWithRecovery(endpoint, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await parseResponse(response);
      if (googlePhone) {
        onAuthenticated(result.customer);
        onClose();
        return;
      }
      if (signup) {
        update("signupId", result.signupId);
        setAuthMode("signup-code");
        return;
      }
      if (signupCode) {
        setForm((current) => ({ ...current, password: "", confirmPassword: "", verificationCode: "" }));
        setAuthMode("signin");
        setSuccess("Thank you for creating an account on VendorWoo!");
        onAuthenticated(result.customer);
        return;
      }
      if (forgotEmail) {
        update("resetId", result.resetId);
        setAuthMode("forgot-code");
        return;
      }
      if (forgotCode) {
        setAuthMode("forgot-password");
        return;
      }
      if (forgotPassword) {
        setForm((current) => ({ ...current, password: "", newPassword: "", confirmNewPassword: "", verificationCode: "" }));
        setAuthMode("signin");
        setSuccess("Your password has been updated. You can now sign in.");
        return;
      }
      onAuthenticated(result.customer);
      onClose();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div
      className="contact-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="customer-auth-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <form
        className="contact-modal category-form customer-auth-form"
        onSubmit={submit}
        noValidate
      >
        <div className="modal-heading">
          <div>
            <div className="eyebrow">CUSTOMER ACCOUNT</div>
            <h2 id="customer-auth-title">
              {signup
                ? "Create your account"
                : googlePhone
                  ? "Complete your account"
                  : signupCode
                    ? "Enter Verification Code"
                    : forgotEmail
                      ? "Forgot Password?"
                      : forgotCode
                        ? "Enter Your Code"
                        : forgotPassword
                          ? "New Password"
                          : "Welcome back"}
            </h2>
            <p>
              {signup
                ? "Join the marketplace and keep your sourcing moving."
                : googlePhone
                  ? "Add your phone number to finish creating your customer account."
                  : signupCode
                    ? `Enter the 6-digit code sent to ${form.emailAddress} to complete your account creation.`
                    : forgotEmail
                      ? "Enter your email address to receive a verification code."
                      : forgotCode
                        ? `Enter the code sent to ${form.emailAddress}.`
                        : forgotPassword
                          ? "Choose a new password for your account."
                          : "Sign in to continue your marketplace journey."}
            </p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close account dialog"
          >
            <X size={18} />
          </button>
        </div>
        {(signup || signin) && (
          <>
            <GoogleAuthButton
              intent={signup ? "signup" : "signin"}
              disabled={submitting}
              onCredential={(credential) => handleGoogleCredential(credential, signup ? "signup" : "signin")}
              onError={setError}
            />
            <div className="customer-auth-divider"><span>or continue with email</span></div>
          </>
        )}
        {signup && (
          <>
            <label>
              Full Name
              <input
                required
                value={form.customerName}
                onChange={(event) => update("customerName", event.target.value)}
                placeholder="Enter your full name"
              />
            </label>
            <label>
              Phone Number
              <input
                required
                value={form.phoneNumber}
                onChange={(event) => update("phoneNumber", event.target.value)}
                placeholder="Enter your phone number"
                inputMode="tel"
              />
            </label>
          </>
        )}
        {googlePhone && (
          <>
            <label>
              Full Name
              <input value={form.customerName} readOnly />
            </label>
            <label>
              Verified Google Email
              <input value={form.emailAddress} readOnly />
            </label>
            <label>
              Phone Number
              <input required value={form.phoneNumber} onChange={(event) => update("phoneNumber", event.target.value)} placeholder="Enter your phone number" inputMode="tel" />
            </label>
          </>
        )}
        {(signup || signin || forgotEmail) && (
          <label>
            Email
            <input
              required
              type="email"
              value={form.emailAddress}
              onChange={(event) => update("emailAddress", event.target.value)}
              placeholder="Enter your email address"
              autoComplete="email"
            />
          </label>
        )}
        {(signup || signin) && (
          <label>
            Password
            <CustomerPasswordField
              name="password"
              value={form.password}
              onChange={(event) => update("password", event.target.value)}
              placeholder="Enter your password"
            />
          </label>
        )}
        {signin && (
          <p className="auth-switch-copy">
            If you don't have an account, please{" "}
            <button
              type="button"
              onClick={() =>
                onSwitchMode
                  ? onSwitchMode("signup")
                  : document
                    .querySelector(".header-auth button:last-child")
                    ?.click()
              }
            >
              Sign up
            </button>
            .
          </p>
        )}
        {signin && (
          <button
            type="button"
            className="auth-forgot-link signin-forgot-link"
            onClick={() => {
              setError("");
              setSuccess("");
              setAuthMode("forgot-email");
            }}
          >
            Forgot Password?
          </button>
        )}
        {signup && (
          <label>
            Confirm Password
            <CustomerPasswordField
              name="confirmPassword"
              value={form.confirmPassword}
              onChange={(event) =>
                update("confirmPassword", event.target.value)
              }
              placeholder="Confirm your password"
            />
          </label>
        )}
        {(forgotCode || signupCode) && (
          <label>
            Verification Code
            <input
              required
              inputMode="numeric"
              maxLength={6}
              value={form.verificationCode}
              onChange={(event) => update("verificationCode", event.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="Enter your 6-digit code"
              autoComplete="one-time-code"
            />
          </label>
        )}
        {forgotPassword && (
          <>
            <label>
              New Password
              <CustomerPasswordField
                name="newPassword"
                value={form.newPassword}
                onChange={(event) => update("newPassword", event.target.value)}
                placeholder="Enter your new password"
              />
            </label>
            <label>
              Confirm Password
              <CustomerPasswordField
                name="confirmNewPassword"
                value={form.confirmNewPassword}
                onChange={(event) => update("confirmNewPassword", event.target.value)}
                placeholder="Confirm your new password"
              />
            </label>
          </>
        )}
        {(signup || googlePhone) && (
          <div className="customer-auth-terms">
            <input
              id="customer-auth-terms"
              type="checkbox"
              required
              checked={form.agreedTerms}
              onChange={(event) => update("agreedTerms", event.target.checked)}
            />
            <span>
              Agree <a href="/VendorWoo_Terms_and_Conditions.pdf" target="_blank" rel="noopener noreferrer">Terms and Conditions</a>
            </span>
          </div>
        )}
        {success && (
          <div className="form-success" role="status">
            {success}
          </div>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="button quiet" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={submitting}
          >
            {submitting ? <Loader /> : <>{signup ? "Sign up" : googlePhone ? "Complete account" : signin ? "Sign in" : signupCode || forgotCode ? "Verify Code" : forgotEmail ? "Send Code" : "Update Password"} <ArrowRight size={16} /></>}
          </button>
        </div>
        {(forgotEmail || forgotCode || forgotPassword) && (
          <button
            type="button"
            className="auth-forgot-link"
            onClick={() => {
              setError("");
              setSuccess("");
              setAuthMode("signin");
            }}
          >
            Back to Sign In
          </button>
        )}
      </form>
    </div>
  );
}
function ProductInquiryModal({ context, customer, onClose }) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(`${API_URL}/inquiries`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: customer?.customerName || "",
          phoneNumber: customer?.phoneNumber || "",
          email: customer?.emailAddress || "",
          message: message.trim(),
          productId: context.productId,
          quantity: context.selectedMoq,
          product: context.title,
          productImage: context.image,
        }),
      });
      await parseResponse(response);
      setSubmitted(true);
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSubmitting(false);
    }
  };
  if (submitted) {
    return (
      <div className="contact-overlay" role="dialog" aria-modal="true" aria-label="Inquiry submitted" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
        <div className="contact-modal inquiry-success-modal">
          <p>Thank you for choosing VendorWoo. Our vendor will be contacted shortly.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="contact-overlay" role="dialog" aria-modal="true" aria-labelledby="product-inquiry-title" onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) onClose(); }}>
      <form className="contact-modal category-form" onSubmit={submit}>
        <div className="modal-heading">
          <div>
            <div className="eyebrow">PRODUCT INQUIRY</div>
            <h2 id="product-inquiry-title">Ask about this product.</h2>
            <p>{context.title}</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close inquiry"><X size={18} /></button>
        </div>
        <div className="inquiry-product-summary">
          {context.image ? <img src={mediaUrl(context.image)} alt="" /> : null}
          <span><strong>Selected MOQ</strong>{context.selectedMoq}</span>
        </div>
        <label>
          Message
          <textarea required value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Tell the supplier what you need..." rows={4} />
        </label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button quiet" onClick={onClose}>Cancel</button>
          <button type="submit" className={`button primary${submitting ? " button-loading" : ""}`} disabled={submitting}>{submitting ? <Loader /> : <>Send inquiry <ArrowRight size={16} /></>}</button>
        </div>
      </form>
    </div>
  );
}

const dispatchProductInquiry = (product, selectedMoq = product.moq || "MOQ not specified") => {
  window.dispatchEvent(new CustomEvent("omni-product-inquiry", {
    detail: { productId: String(product._id), title: product.title || product.name, image: product.image || product.images?.[0] || "", selectedMoq },
  }));
};
const dispatchProductLiveChat = (product, productId, image, selectedMoq) => {
  window.dispatchEvent(new CustomEvent("omni-product-live-chat", {
    detail: {
      productId: String(product?._id || productId),
      title: product?.title || product?.name || "Product",
      image: image || product?.image || product?.images?.[0] || "",
      selectedMoq: selectedMoq || product?.moq || "MOQ not specified",
    },
  }));
};

const dispatchChatState = (chat) => {
  window.dispatchEvent(new CustomEvent(`omni-${chat}-chat-open`));
};

function ShoppingChat() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [image, setImage] = useState(null);
  const [imagePreview, setImagePreview] = useState("");
  const [sending, setSending] = useState(false);
  const [messages, setMessages] = useState([]);
  const [sourcingState, setSourcingState] = useState(null);
  const [revealingMessageId, setRevealingMessageId] = useState(null);
  const isMobileAttachment = typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
  useEffect(() => {
    if (!image) {
      setImagePreview("");
      return undefined;
    }
    const objectUrl = URL.createObjectURL(image);
    setImagePreview(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [image]);
  useEffect(() => {
    if (!revealingMessageId) return undefined;
    const target = messages.find((item) => item._typingId === revealingMessageId);
    if (!target || !target.fullText) {
      setRevealingMessageId(null);
      return undefined;
    }
    if ((target.text || "").length >= target.fullText.length) {
      setRevealingMessageId(null);
      return undefined;
    }
    const timer = setTimeout(() => {
      setMessages((current) =>
        current.map((item) => {
          if (item._typingId !== revealingMessageId) return item;
          const nextLength = (item.text || "").length + 1;
          return { ...item, text: item.fullText.slice(0, nextLength) };
        }),
      );
    }, 22);
    return () => clearTimeout(timer);
  }, [messages, revealingMessageId]);
  useEffect(() => {
    const closeForLiveChat = () => setOpen(false);
    window.addEventListener("omni-live-chat-open", closeForLiveChat);
    return () => window.removeEventListener("omni-live-chat-open", closeForLiveChat);
  }, []);
  useEffect(() => {
    const handleChatKeyDown = (event) => {
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        event.target.matches?.(".shopping-chat-compose textarea")
      ) {
        event.preventDefault();
        event.target.form?.requestSubmit();
      }
    };
    document.addEventListener("keydown", handleChatKeyDown);
    if (open) {
      const messagesElement = document.querySelector(".shopping-chat-messages");
      messagesElement?.scrollTo({
        top: messagesElement.scrollHeight,
        behavior: "smooth",
      });
    }
    return () => document.removeEventListener("keydown", handleChatKeyDown);
  }, [open, messages, sending]);
  const toggleChat = () => {
    if (open) return setOpen(false);
    dispatchChatState("shopping");
    setOpen(true);
  };
  const send = async (event) => {
    event.preventDefault();
    const text = message.trim();
    if ((!text && !image) || sending) return;
    const userMessage = {
      role: "user",
      text,
      image: image ? URL.createObjectURL(image) : "",
    };
    const history = messages.map(
      ({ role, text: historyText, products: shownProducts }) => ({
        role,
        text: historyText,
        products: role === "assistant" ? shownProducts?.slice(0, 4) : undefined,
      }),
    );
    setMessages((current) => [...current, userMessage]);
    setMessage("");
    setSending(true);
    const formData = new FormData();
    formData.append("message", text);
    formData.append("history", JSON.stringify(history));
    if (sourcingState) formData.append("sourcingState", JSON.stringify(sourcingState));
    if (image) formData.append("image", image);
    setImage(null);
    try {
      const response = await fetch(`${API_URL}/shopping-chat`, {
        method: "POST",
        body: formData,
      });
      const result = await parseResponse(response);
      setSourcingState(result.sourcingState || null);
      if (result.humanHandoff) {
        setMessages((current) => [
          ...current,
          { role: "assistant", humanAssistance: true },
        ]);
        return;
      }
      const revealId = Date.now() + Math.random();
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          text: "",
          fullText: result.reply || "",
          products: result.products || [],
          _typingId: revealId,
        },
      ]);
      setRevealingMessageId(revealId);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          text: "Shopping Chat is temporarily unavailable. Please try again shortly.",
        },
      ]);
    } finally {
      setSending(false);
    }
  };
  return (
    <>
      <a
        className="whatsapp-trigger"
        href="https://wa.me/19406180291"
        target="_blank"
        rel="noreferrer"
        aria-label="Chat on WhatsApp"
      >
        <img src="/whatsapp.svg" alt="WhatsApp" />
      </a>
      <img
        className="shopping-chat-trigger"
        onClick={toggleChat}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleChat();
          }
        }}
        aria-label={open ? "Close Shopping Chat" : "Open Shopping Chat"}
        role="button"
        tabIndex={0}
        src="/Aibot.svg"
        alt="Chat"
      />
      {open && (
        <section className="shopping-chat-panel" aria-label="Shopping Chat">
          <div className="shopping-chat-header">
            <div>
              <strong>Shopping Chat</strong>
              <small>Find products from our marketplace</small>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close Shopping Chat"
            >
              <X size={17} />
            </button>
          </div>
          <div className="shopping-chat-messages">
            {!messages.length && (
              <div className="shopping-chat-empty">
                <span>
                  <MessageCircle size={20} />
                </span>
                <strong>What are you sourcing?</strong>
                <p>
                  Tell me what you need and I will look through the marketplace.
                </p>
              </div>
            )}
            {messages.map((item, index) => (
              <div
                className={`shopping-chat-message ${item.role}`}
                key={`${item.role}-${index}`}
              >
                <div className="shopping-chat-bubble">
                  {item.image && (
                    <img
                      className="shopping-chat-upload"
                      src={item.image}
                      alt="Uploaded product reference"
                    />
                  )}
                  {item.text && <p>{item.text}</p>}
                  {item.humanAssistance && (
                    <button
                      type="button"
                      className="shopping-chat-human-link"
                      onClick={() => window.dispatchEvent(new CustomEvent("omni-human-live-chat-request"))}
                    >
                      Click here to talk to our human agent
                      <ArrowRight size={14} />
                    </button>
                  )}
                  {item.products?.length > 0 && (
                    <div className="shopping-chat-products">
                      {item.products.map((product) => (
                        <a
                          className="shopping-chat-product"
                          href={`/products/${product.id}`}
                          key={product.id}
                        >
                          <img src={mediaUrl(product.image)} alt="" />
                          <span>
                            <strong>{product.title}</strong>
                            <small>
                              {product.price || "Price on request"} · MOQ{" "}
                              {product.moq || "Available"}
                            </small>
                          </span>
                          <ArrowRight size={13} />
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {sending && (
              <div className="shopping-chat-message assistant">
                <div className="shopping-chat-bubble shopping-chat-typing" />
              </div>
            )}
          </div>
          <form className="shopping-chat-compose" onSubmit={send}>
            <div className="shopping-chat-attachment">
              <label aria-label="Upload product image">
                <Image size={17} />
                <input
                  type="file"
                  accept={isMobileAttachment ? "image/*" : "image/jpeg,image/png,image/webp,image/gif"}
                  capture={isMobileAttachment ? "environment" : undefined}
                  onChange={(event) =>
                    setImage(event.target.files?.[0] || null)
                  }
                />
              </label>
            </div>
            <div className="shopping-chat-input-wrap">
              {image && (
                <div className="shopping-chat-attachment-preview">
                  <img src={imagePreview} alt="Selected product" />
                  <button
                    type="button"
                    aria-label="Remove selected image"
                    onClick={() => setImage(null)}
                  >
                    ×
                  </button>
                </div>
              )}
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Describe what you need..."
                rows="1"
                aria-label="Shopping Chat message"
              />
            </div>
            <button
              type="submit"
              disabled={sending || (!message.trim() && !image)}
              aria-label="Send message"
            >
              <Send size={16} />
            </button>
          </form>
        </section>
      )}
    </>
  );
}

function Header({ onDashboard, productContext = null }) {
  const [open, setOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState({ products: [], categories: [] });
  const [searching, setSearching] = useState(false);
  const [authModal, setAuthModal] = useState(null);
  const [customer, setCustomer] = useState(null);
  const [activeNav, setActiveNav] = useState(() => {
    const pathname = window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    if (pathname === "/") return params.get("contact") === "1" ? "Contact" : "Home";
    if (pathname.startsWith("/categories")) return "Categories";
    if (pathname.startsWith("/products")) return "Products";
    if (pathname.startsWith("/community")) return "Community";
    if (pathname.startsWith("/cbm-calculator")) return "CBM Calculator";
    if (pathname.startsWith("/about")) return "About";
    return "Home";
  });
  const syncActiveNav = () => {
    const pathname = window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    const next = pathname === "/"
      ? (params.get("contact") === "1" ? "Contact" : "Home")
      : pathname.startsWith("/categories")
        ? "Categories"
        : pathname.startsWith("/products")
          ? "Products"
          : pathname.startsWith("/community")
            ? "Community"
            : pathname.startsWith("/cbm-calculator")
              ? "CBM Calculator"
              : pathname.startsWith("/about")
                ? "About"
                : "Home";
    setActiveNav(next);
  };
  const [activeProductContext, setActiveProductContext] = useState(null);
  const [pendingProductContext, setPendingProductContext] = useState(null);
  const [inquiryContext, setInquiryContext] = useState(null);
  const [pendingInquiryContext, setPendingInquiryContext] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [liveChatUnreadCount, setLiveChatUnreadCount] = useState(0);
  const refreshLiveChatUnreadCount = async () => {
    if (!customer) {
      setLiveChatUnreadCount(0);
      return;
    }
    try {
      const result = await fetch(`${API_URL}/messages/customer/unread-count`, {
        credentials: "include",
        cache: "no-store",
        headers: { ...authHeaders() },
      }).then(parseResponse);
      setLiveChatUnreadCount(Number(result?.unreadCount || 0));
    } catch {
      setLiveChatUnreadCount(0);
    }
  };
  const goToContact = (event) => {
    event.preventDefault();
    setOpen(false);
    setActiveNav("Contact");
    if (window.location.pathname === "/") {
      const section = document.getElementById("contact");
      if (!section) return;
      const top = section.getBoundingClientRect().top + window.scrollY - 74;
      window.scrollTo({ top, left: 0, behavior: "smooth" });
      return;
    }
    window.location.href = "/?contact=1";
  };
  useEffect(() => {
    syncActiveNav();
    const handlePopState = () => syncActiveNav();
    const requestCommunitySignIn = () => {
      setAuthModal("signin");
      setProfileOpen(false);
      setOpen(false);
    };
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("marketplace-auth-required", requestCommunitySignIn);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("marketplace-auth-required", requestCommunitySignIn);
    };
  }, []);
  useEffect(() => {
    const sessionPath = window.location.pathname.startsWith("/community")
      ? "/community/session"
      : "/customer-auth/me";
    fetchWithRecovery(`${API_URL}${sessionPath}`, { credentials: "include" })
      .then((response) => (response.ok ? response.json() : null))
      .then((result) => setCustomer(result?.customer || null))
      .catch(() => setCustomer(null));
  }, []);
  useEffect(() => {
    if (!customer) {
      setLiveChatUnreadCount(0);
      return undefined;
    }
    void refreshLiveChatUnreadCount();
    const onStorage = (event) => {
      if (event.key === messageSyncKey) void refreshLiveChatUnreadCount();
    };
    const onSync = () => {
      window.dispatchEvent(new CustomEvent("marketplace-customer-auth-changed", { detail: null }));
      void refreshLiveChatUnreadCount();
    };
    window.addEventListener("storage", onStorage);
    messageSyncChannel?.addEventListener("message", onSync);
    const pollingTimer = setInterval(() => { void refreshLiveChatUnreadCount(); }, 2500);
    return () => {
      window.removeEventListener("storage", onStorage);
      messageSyncChannel?.removeEventListener("message", onSync);
      clearInterval(pollingTimer);
    };
  }, [customer]);
  useEffect(() => {
    if (!query.trim()) {
      setSearching(false);
      setResults({ products: [], categories: [] });
      return undefined;
    }
    const timer = setTimeout(() => {
      setSearching(true);
      fetch(`${API_URL}/search?q=${encodeURIComponent(query.trim())}`)
        .then(parseResponse)
        .then(setResults)
        .catch(() => setResults({ products: [], categories: [] }))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  const logoutCustomer = async () => {
    await fetch(`${API_URL}/customer-auth/logout`, {
      method: "POST",
      credentials: "include",
    }).catch(() => { });
    setCustomer(null);
    setProfileOpen(false);
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
    setResults({ products: [], categories: [] });
  };
  const hasResults =
    results.products.length > 0 || results.categories.length > 0;
  const handleLiveChatClick = (productContext = null) => {
    dispatchChatState("live");
    if (customer) {
      setSearchOpen(false);
      setProfileOpen(false);
      setAuthModal(null);
      setActiveProductContext(productContext);
      return setLiveChatOpen(true);
    }
    setPendingProductContext(productContext);
    setLiveChatPending(true);
    setAuthModal("signin");
    setProfileOpen(false);
  };
  const handleProductInquiryClick = (productContext) => {
    setSearchOpen(false);
    setProfileOpen(false);
    if (customer) {
      setInquiryContext(productContext);
      return;
    }
    setPendingInquiryContext(productContext);
    setAuthModal("signin");
  };
  const [liveChatOpen, setLiveChatOpen] = useState(() => sessionStorage.getItem("omni-live-chat-open") === "1");
  const [liveChatPending, setLiveChatPending] = useState(false);
  useEffect(() => { sessionStorage.setItem("omni-live-chat-open", liveChatOpen ? "1" : "0"); }, [liveChatOpen]);
  useEffect(() => {
    const closeForShoppingChat = () => setLiveChatOpen(false);
    window.addEventListener("omni-shopping-chat-open", closeForShoppingChat);
    return () => window.removeEventListener("omni-shopping-chat-open", closeForShoppingChat);
  }, []);
  useEffect(() => {
    const handleProductLiveChat = (event) => handleLiveChatClick(event.detail || null);
    const handleProductInquiry = (event) => handleProductInquiryClick(event.detail || null);
    const handleHumanLiveChat = () => handleLiveChatClick();
    window.addEventListener("omni-product-live-chat", handleProductLiveChat);
    window.addEventListener("omni-product-inquiry", handleProductInquiry);
    window.addEventListener("omni-human-live-chat-request", handleHumanLiveChat);
    return () => {
      window.removeEventListener("omni-product-live-chat", handleProductLiveChat);
      window.removeEventListener("omni-product-inquiry", handleProductInquiry);
      window.removeEventListener("omni-human-live-chat-request", handleHumanLiveChat);
    };
  }, [customer]);
  const handleCustomerAuthenticated = (nextCustomer) => {
    setCustomer(nextCustomer);
    window.dispatchEvent(new CustomEvent("marketplace-customer-auth-changed", { detail: nextCustomer }));
    setAuthModal(null);
    if (liveChatPending) {
      setActiveProductContext(pendingProductContext);
      setLiveChatOpen(true);
      setLiveChatPending(false);
      setPendingProductContext(null);
    }
    if (pendingInquiryContext) {
      setInquiryContext(pendingInquiryContext);
      setPendingInquiryContext(null);
    }
  };
  const openSignInForLiveChat = () => {
    setLiveChatPending(true);
    setAuthModal("signin");
  };
  return (
    <header className="header">
      <div className="nav-wrap">
        <a className="brand" href="#top">
          Vendor <span>Woo</span>
        </a>
        <nav className={open ? "nav open" : "nav"}>
          <a
            href="/"
            className={activeNav === "Home" ? "active" : ""}
            onClick={(event) => {
              event.preventDefault();
              setOpen(false);
              setActiveNav("Home");
              const nextUrl = "/";
              const isAlreadyHome = window.location.pathname === "/";
              window.history.pushState({}, "", nextUrl);
              window.dispatchEvent(new PopStateEvent("popstate"));
              if (isAlreadyHome) {
                window.scrollTo({ top: 0, left: 0, behavior: "auto" });
                return;
              }
              requestAnimationFrame(() => {
                window.scrollTo({ top: 0, left: 0, behavior: "auto" });
              });
            }}
          >
            Home
          </a>
          <a
            href="/categories"
            className={activeNav === "Categories" ? "active" : ""}
            onClick={() => {
              setOpen(false);
              setActiveNav("Categories");
            }}
          >
            Categories
          </a>
          <a
            href="/products"
            className={activeNav === "Products" ? "active" : ""}
            onClick={() => {
              setOpen(false);
              setActiveNav("Products");
            }}
          >
            Products
          </a>
          <a
            href="/community"
            className={activeNav === "Community" ? "active" : ""}
            onClick={() => {
              setOpen(false);
              setActiveNav("Community");
            }}
          >
            Community
          </a>
          <a
            href="/cbm-calculator"
            className={activeNav === "CBM Calculator" ? "active" : ""}
            onClick={() => {
              setOpen(false);
              setActiveNav("CBM Calculator");
            }}
          >
            CBM Calculator
          </a>
          <a
            href="/about"
            className={activeNav === "About" ? "active" : ""}
            onClick={() => {
              setOpen(false);
              setActiveNav("About");
            }}
          >
            About us
          </a>
          {/* <a
            href="#contact"
            className={activeNav === "Contact" ? "active" : ""}
            onClick={goToContact}
          >
            Contact
          </a> */}
        </nav>
        <div className="header-actions">
          {searchOpen ? (
            <div className="header-search">
              <Search size={17} />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search products or categories"
                aria-label="Search products or categories"
                aria-expanded={Boolean(query)}
              />
              <button
                type="button"
                className="search-clear"
                onClick={query ? () => setQuery("") : closeSearch}
                aria-label={query ? "Clear search" : "Close search"}
              >
                {query ? <X size={16} /> : <X size={17} />}
              </button>
              {query && (
                <div className="search-results" role="status">
                  {searching && (
                    <div className="search-state search-loading"><Loader /></div>
                  )}
                  {!searching && !hasResults && (
                    <div className="search-state search-empty">
                      <Search size={18} />
                      <strong>No matches found</strong>
                      <span>Try a product name or category.</span>
                    </div>
                  )}
                  {!searching && hasResults && (
                    <div className="search-result-list">
                      {results.products.map((product) => (
                        <a
                          className="search-result"
                          key={`product-${product._id}`}
                          href={`/products/${product._id}`}
                        >
                          <span className="search-result-image">
                            {product.image ? (
                              <img src={mediaUrl(product.image)} alt="" />
                            ) : (
                              <Package size={16} />
                            )}
                          </span>
                          <span className="search-result-copy">
                            <strong>{product.title || product.name}</strong>
                            <small>
                              {product.category || "Product"}
                              {product.price
                                ? ` · From ${formatPrice(product.price)}`
                                : ""}
                            </small>
                          </span>
                          <ArrowRight size={15} />
                        </a>
                      ))}
                      {results.categories.map((category) => (
                        <a
                          className="search-result"
                          key={`category-${category._id}`}
                          href={`/categories/${category.slug}`}
                        >
                          <span className="search-result-image category-result-icon">
                            <Tag size={16} />
                          </span>
                          <span className="search-result-copy">
                            <strong>{category.name}</strong>
                            <small>Category collection</small>
                          </span>
                          <ArrowRight size={15} />
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <button
              className="icon-button"
              aria-label="Search"
              onClick={() => setSearchOpen(true)}
            >
              <Search size={18} />
            </button>
          )}
          <button
            type="button"
            className="header-live-chat"
            onClick={() => handleLiveChatClick(productContext)}
            aria-label="Open live chat"
          >
            <MessageCircle size={14} />
            <span>Live Chat</span>
            {liveChatUnreadCount > 0 ? <b className="header-live-chat-badge">{liveChatUnreadCount}</b> : null}
          </button>
          {customer ? (
            <div className="profile-menu">
              <button
                className="avatar"
                aria-label="Open profile"
                onClick={() => setProfileOpen((current) => !current)}
              >
                {customer.customerName.slice(0, 2).toUpperCase()}
              </button>
              {profileOpen && (
                <div className="profile-dropdown">
                  <div className="profile-dropdown-field">
                    <small>User Name</small>
                    <strong>{customer.customerName}</strong>
                  </div>
                  <div className="profile-dropdown-field">
                    <small>Phone Number</small>
                    <strong>{customer.phoneNumber || "Not provided"}</strong>
                  </div>
                  <div className="profile-dropdown-field">
                    <small>Email</small>
                    <strong>{customer.emailAddress}</strong>
                  </div>
                  <div className="profile-dropdown-actions">
                    <button type="button" onClick={logoutCustomer}>
                      Logout
                    </button>
                    <button
                      type="button"
                      className="profile-cancel"
                      onClick={() => setProfileOpen(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="header-auth">
              <button type="button" onClick={() => setAuthModal("signin")}>
                Sign In
              </button>
              <button type="button" onClick={() => setAuthModal("signup")}>
                Sign Up
              </button>
            </div>
          )}
          <button
            type="button"
            className="menu-button"
            onClick={() => setOpen(!open)}
            aria-label="Menu"
            aria-expanded={open}
          >
            {open ? <X size={21} /> : <Menu size={21} />}
          </button>
        </div>
      </div>
      {authModal && (
        <CustomerAuthModal
          mode={authModal}
          onClose={() => {
            setAuthModal(null);
            setLiveChatPending(false);
            setPendingInquiryContext(null);
            window.dispatchEvent(new CustomEvent("marketplace-auth-cancelled"));
          }}
          onAuthenticated={handleCustomerAuthenticated}
        />
      )}
      {inquiryContext && (
        <ProductInquiryModal
          context={inquiryContext}
          customer={customer}
          onClose={() => setInquiryContext(null)}
        />
      )}
      <CustomerChatPanel
        open={liveChatOpen}
        customer={customer}
        productContext={activeProductContext}
        onClose={() => setLiveChatOpen(false)}
      />
    </header>
  );
}

function Hero({ onBrowse }) {
  const [active, setActive] = useState(0);
  const [previous, setPrevious] = useState(0);
  const activeRef = useRef(0);
  const goTo = (next) => {
    setPrevious(activeRef.current);
    activeRef.current = next;
    setActive(next);
  };
  useEffect(() => {
    const timer = setInterval(() => {
      const next = (activeRef.current + 1) % slides.length;
      goTo(next);
    }, 6000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setPrevious(active), 820);
    return () => clearTimeout(timer);
  }, [active]);
  const slide = slides[active];
  return (
    <section className="hero" id="top">
      <div key={active} className="hero-track">
        <div
          className="hero-image"
          style={{
            backgroundImage: `linear-gradient(90deg, rgba(23,59,58,.86) 0%, rgba(23,59,58,.54) 42%, rgba(23,59,58,.08) 78%), url(${slides[previous].image})`,
          }}
        />
        <div
          className="hero-image"
          style={{
            backgroundImage: `linear-gradient(90deg, rgba(23,59,58,.86) 0%, rgba(23,59,58,.54) 42%, rgba(23,59,58,.08) 78%), url(${slide.image})`,
          }}
        />
      </div>
      <div className="hero-content">
        <div className="eyebrow light">
          <Sparkles size={14} /> {slide.eyebrow}
        </div>
        <h1>{slide.title}</h1>
        <p>{slide.text}</p>
        <div className="hero-actions">
          <button className="button primary" onClick={onBrowse}>
            Explore products <ArrowRight size={17} />
          </button>
          <a className="button outline" href="/categories">
            Browse categories
          </a>
        </div>
      </div>
      <div className="slide-controls">
        <button
          onClick={() => goTo((active + slides.length - 1) % slides.length)}
          aria-label="Previous slide"
        >
          <ChevronLeft size={18} />
        </button>
        {slides.map((item, index) => (
          <button
            key={item.image}
            className={index === active ? "dot active" : "dot"}
            onClick={() => goTo(index)}
            aria-label={`Slide ${index + 1}`}
          />
        ))}
        <button
          onClick={() => goTo((active + 1) % slides.length)}
          aria-label="Next slide"
        >
          <ChevronRight size={18} />
        </button>
        <span>
          0{active + 1} / 0{slides.length}
        </span>
      </div>
    </section>
  );
}

function TrustStrip() {
  const badges = [
    { icon: CreditCard, title: "Payment Assurance", text: "Source with confidence" },
    { icon: PackageCheck, title: "Quality Assurance", text: "Quality checked products" },
    { icon: BadgeCheck, title: "Verified Suppliers", text: "A trust first network" },
    { icon: ShieldCheck, title: "Buyer Protection", text: "Confidence at every step" },
    { icon: Globe2, title: "Global Sourcing", text: "Suppliers across markets" },
    { icon: LockKeyhole, title: "Secure Transactions", text: "Security minded sourcing" },
  ];

  return (
    <section className="trust-strip" aria-label="Marketplace values">
      <div className="trust-strip-inner">
        {badges.map(({ icon: Icon, title, text }) => (
          <div className="trust-badge" key={title}>
            <span className="trust-badge-icon" aria-hidden="true">
              <Icon size={19} strokeWidth={1.8} />
            </span>
            <span className="trust-badge-copy">
              <strong>{title}</strong>
              <small>{text}</small>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function CategoryMarquee({ items = [], onCategory, loading = false }) {
  const names = items.map((category) =>
    typeof category === "string" ? category : category.name,
  );
  return (
    <section className="marquee-section" id="categories">
      {loading ? <div className="loading-region marquee-loading"><Loader /></div> : (
        <div className="marquee-window">
          <div className="marquee-track">
            {[...names, ...names].map((category, index) => (
              <button
                key={`${category}-${index}`}
                onClick={() => onCategory(category)}
              >
                {category}
                <span>-&gt;</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function GlobalFooter() {
  return (
    <footer>
      <div className="footer-main">
        <div className="brand">
          Vendor <span>Woo</span>
          <p>A sharper way to source globally.</p>
        </div>
        <div>
          <strong>Marketplace</strong>
          <a href="/categories">Categories</a>
          <a href="/products">Featured products</a>
          <a href="/contact">Supplier network</a>
        </div>
        <div>
          <strong>Company</strong>
          <a href="/about">About us</a>
          <a href="/?contact=1">Contact</a>
          <a
            href="/VendorWoo_Terms_and_Conditions.pdf"
            target="_blank"
            rel="noopener noreferrer"
          >
            Terms &amp; Conditions
          </a>
        </div>
        <div>
          <strong>Stay in the loop</strong>
          <p>Useful market notes, occasionally.</p>
          <label className="subscribe">
            <input placeholder="Work email" />
            <button aria-label="Subscribe">
              <ArrowRight size={16} />
            </button>
          </label>
        </div>
      </div>
      <div className="footer-bottom">
        <span>(c) 2026 Vendor Woo</span>
        <span>Built for better business.</span>
      </div>
    </footer>
  );
}

function AboutPage() {
  const features = [
    {
      title: "Factory Direct",
      text: "Connect with manufacturers and factory owners.",
    },
    {
      title: "Competitive B2B Pricing",
      text: "Explore pricing based on wholesale quantities, specifications, customization, and supplier terms.",
    },
    {
      title: "Customization",
      text: "Explore customized, private-label, and specially manufactured products.",
    },
    {
      title: "Global Sourcing",
      text: "Source products from China and suppliers across international markets.",
    },
  ];

  const reasons = [
    ["Global Supplier Network", "Connect with manufacturers and suppliers across China and international markets."],
    ["Direct Factory Connections", "Discover products directly from manufacturers and factory owners."],
    ["Competitive B2B Pricing", "Explore pricing based on wholesale quantities, specifications, and supplier terms."],
    ["Quality-Control Support", "Access inspection and quality-control services where available."],
    ["Global Sourcing", "Source products for wholesale, resale, distribution, manufacturing, and business operations."],
    ["Direct Communication", "Communicate product requirements and business needs with suppliers."],
    ["Custom & Private Label", "Explore customized and private-label manufacturing opportunities."],
    ["International B2B Marketplace", "Built for businesses sourcing across borders."],
  ];

  const processSteps = [
    ["Order Placed", "Buyer confirms the product, quantity, specifications, and requirements."],
    ["Supplier Produces the Order", "The manufacturer prepares the order according to the agreed requirements."],
    ["Inspection", "Where applicable, our inspection and quality-control process checks the order against agreed specifications."],
    ["Quality Verification", "The product is reviewed for issues such as visible defects, quantity discrepancies, specifications, packaging, or other agreed requirements."],
    ["Shipment", "Once the applicable process is completed, the order proceeds toward shipment."],
  ];

  const buyers = [
    "Wholesalers",
    "Retailers",
    "Distributors",
    "Importers",
    "Manufacturers",
    "Private-Label Businesses",
    "Startups",
    "Growing Businesses",
  ];

  return (
    <main className="about-page">
      <section className="about-hero">
        <div className="about-hero-inner">
          <div className="about-hero-copy">
            <div className="eyebrow light">VENDOR WOO</div>
            <h1>Source Directly. Buy Smarter. Grow Globally.</h1>
            <p>
              Vendor Woo is a global B2B marketplace connecting businesses with
              manufacturers, factory owners, suppliers, and wholesalers—especially
              across China and international markets.
            </p>
            <div className="hero-actions">
              <a className="button primary" href="/products">
                Explore Products <ArrowRight size={17} />
              </a>
              <a className="button outline" href="/?contact=1">
                Start Sourcing
              </a>
            </div>
          </div>
          <div className="about-hero-panel">
            <div className="about-hero-panel-grid">
              <div className="about-stat">
                <strong>Global</strong>
                <span>Supplier reach</span>
              </div>
              <div className="about-stat">
                <strong>Direct</strong>
                <span>Factory access</span>
              </div>
              <div className="about-stat">
                <strong>Reliable</strong>
                <span>Buyer sourcing</span>
              </div>
              <div className="about-stat">
                <strong>Smarter</strong>
                <span>Commercial decisions</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="about-section">
        <div className="section-heading about-heading">
          <div>
            <h2>Who We Are</h2>
          </div>
        </div>
        <div className="about-story">
          <div className="about-story-copy">
            <p>
              Vendor Woo is a global B2B marketplace built to make international
              sourcing simpler, more transparent, and more reliable. We connect
              businesses directly with manufacturers, factory owners, suppliers,
              and wholesalers so buyers can discover products, communicate with
              suppliers, place orders, and source products for wholesale, resale,
              manufacturing, distribution, and business use.
            </p>
          </div>
          <div className="about-story-card">
            <div className="mini-metric">
              <span>Direct sourcing</span>
              <strong>From manufacturers to businesses</strong>
            </div>
            <div className="mini-metric">
              <span>Trade clarity</span>
              <strong>More transparent product discovery</strong>
            </div>
            <div className="mini-metric">
              <span>Global network</span>
              <strong>Built for cross-border B2B growth</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="about-section about-feature-block">
        <div className="section-heading about-heading">
          <div>
            <h2>Direct Access to Manufacturers</h2>
          </div>
        </div>
        <div className="about-feature-grid">
          {features.map((feature) => (
            <article className="about-card" key={feature.title}>
              <div className="about-card-kicker">{feature.title}</div>
              <p>{feature.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="about-manufacturing">
        <div className="about-manufacturing-copy">
          <h2>Your Gateway to Chinese Manufacturing</h2>
          <p>
            China is one of the world&apos;s major manufacturing and sourcing hubs.
            Vendor Woo connects international buyers with manufacturers and
            suppliers across China, helping businesses discover products, compare
            sourcing options, communicate requirements, and build long-term
            supplier relationships.
          </p>
        </div>
        <div className="about-manufacturing-visual" aria-hidden="true" />
      </section>

      <section className="about-section quality-section">
        <div className="section-heading about-heading">
          <div>
            <h2>Quality Checked Before It Reaches You</h2>
          </div>
        </div>
        <div className="about-quality-intro">
          <p>
            We believe sourcing is not only about finding the right price—it is
            also about receiving the product you actually ordered. Where
            inspection or quality-control services are available, Vendor Woo can
            facilitate product inspection before shipment for eligible B2B orders.
          </p>
        </div>
        <div className="process-grid">
          {processSteps.map(([title, text], index) => (
            <div className="process-step" key={title}>
              <span className="process-number">0{index + 1}</span>
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
          ))}
        </div>
        <div className="quality-support">
          Our inspection process is designed to reduce sourcing risks and help buyers
          receive products that align with the agreed specifications.
        </div>
      </section>

      <section className="about-section about-feature-block">
        <div className="section-heading about-heading">
          <div>
            <h2>Why Businesses Choose Vendor Woo</h2>
          </div>
        </div>
        <div className="about-feature-grid reasons-grid">
          {reasons.map(([title, text]) => (
            <article className="about-card" key={title}>
              <div className="about-card-kicker">{title}</div>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="about-section">
        <div className="section-heading about-heading">
          <div>
            <h2>Source in 5 Simple Steps</h2>
          </div>
        </div>
        <div className="how-grid">
          {[
            ["Discover", "Explore products from manufacturers and suppliers."],
            ["Compare", "Review specifications, quantities, pricing, and supplier information."],
            ["Connect", "Discuss your requirements directly with suppliers."],
            ["Order", "Place your B2B order through Vendor Woo."],
            ["Inspect & Ship", "Where applicable, quality-control or inspection services can be facilitated before shipment, followed by shipping coordination."],
          ].map(([title, text], index) => (
            <div className="how-step" key={title}>
              <span className="process-number">0{index + 1}</span>
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="about-section">
        <div className="section-heading about-heading">
          <div>
            <h2>Built for Global Buyers</h2>
          </div>
        </div>
        <p className="about-intro">
          Whether you are a wholesaler, retailer, distributor, manufacturer,
          startup, or growing business, Vendor Woo helps you discover and source
          products from international suppliers.
        </p>
        <div className="buyer-chip-list">
          {buyers.map((buyer) => (
            <span className="buyer-chip" key={buyer}>{buyer}</span>
          ))}
        </div>
      </section>

      <section className="about-section mission-block">
        <div className="mission-card">
          <h2>Our Mission</h2>
          <p>
            To make global B2B sourcing more accessible, transparent, and reliable by
            connecting businesses with manufacturers and suppliers while providing the
            tools and support they need to source with greater confidence.
          </p>
        </div>
      </section>

      <section className="about-section commitment-block">
        <div className="section-heading about-heading">
          <div>
            <h2>Our Commitment to Buyers</h2>
          </div>
        </div>
        <div className="commitment-grid">
          {[
            ["Transparency", "Clear and accessible product and supplier information."],
            ["Direct Access", "Connections with manufacturers and suppliers at the source."],
            ["Quality-Conscious Sourcing", "Inspection and quality-control support where available."],
            ["Global Accessibility", "Built for businesses sourcing products across international markets."],
          ].map(([title, text]) => (
            <div className="commitment-item" key={title}>
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="about-cta">
        <div>
          <h2>Ready to Source Smarter?</h2>
          <p>
            Discover manufacturers, explore products, and start building your global
            supply network with Vendor Woo.
          </p>
        </div>
        <div className="hero-actions about-cta-actions">
          <a className="button primary" href="/products">
            Explore Products <ArrowRight size={17} />
          </a>
          <a className="button dark" href="/?contact=1">
            Start Sourcing
          </a>
        </div>
      </section>

      <section className="about-section policy-section">
        <div className="policy-panel">
          <h3>Our Policies</h3>
          <p>
            Your use of Vendor Woo is subject to our <a href="/VendorWoo_Terms_and_Conditions.pdf" target="_blank" rel="noopener noreferrer">Terms &amp; Conditions</a> and Privacy Policy. Please review these policies before using the platform or placing an order.
          </p>
        </div>
      </section>
    </main>
  );
}

function CategoriesPage({ selectedSlug }) {
  const [categoryData, setCategoryData] = useState([]);
  const [pageProducts, setPageProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [productsLoading, setProductsLoading] = useState(false);
  const categoryRequestIdRef = useRef(0);
  const categoryProductsRequestIdRef = useRef(0);
  const loadCategories = () => {
    const requestId = ++categoryRequestIdRef.current;
    setLoading(true);
    getJson("/categories?page=1&limit=100", 30000)
      .then((result) => {
        if (requestId === categoryRequestIdRef.current)
          setCategoryData(result.data || []);
      })
      .catch(() => {
        if (requestId === categoryRequestIdRef.current) setCategoryData([]);
      })
      .finally(() => {
        if (requestId === categoryRequestIdRef.current) setLoading(false);
      });
  };
  useEffect(() => {
    loadCategories();
    const refresh = () => {
      invalidateClientCache("/categories");
      invalidateClientCache("/products");
      loadCategories();
    };
    const onStorage = (event) => {
      if (event.key === catalogChangeKey) refresh();
    };
    window.addEventListener("storage", onStorage);
    catalogSyncChannel?.addEventListener("message", refresh);
    return () => {
      categoryRequestIdRef.current += 1;
      window.removeEventListener("storage", onStorage);
      catalogSyncChannel?.removeEventListener("message", refresh);
    };
  }, []);
  const selected = categoryData.find(
    (category) => category.slug === selectedSlug,
  );
  useEffect(() => {
    const requestId = ++categoryProductsRequestIdRef.current;
    if (!selected) {
      setPageProducts([]);
      setProductsLoading(false);
      return () => {
        if (requestId === categoryProductsRequestIdRef.current)
          categoryProductsRequestIdRef.current += 1;
      };
    }
    setProductsLoading(true);
    getJson(`/products?category=${encodeURIComponent(selected.name)}&sort=hot-selling&limit=12&page=1`)
      .then((result) => {
        if (requestId === categoryProductsRequestIdRef.current)
          setPageProducts(result.data || []);
      })
      .catch(() => {
        if (requestId === categoryProductsRequestIdRef.current)
          setPageProducts([]);
      })
      .finally(() => {
        if (requestId === categoryProductsRequestIdRef.current)
          setProductsLoading(false);
      });
    return () => {
      if (requestId === categoryProductsRequestIdRef.current)
        categoryProductsRequestIdRef.current += 1;
    };
  }, [selected]);
  if (selectedSlug && loading)
    return (
      <>
        <Header onDashboard={() => { window.location.href = "/dashboard"; }} />
        <main className="category-products-page category-detail-page loading-region"><Loader /></main>
        <GlobalFooter />
      </>
    );
  if (selectedSlug)
    return (
      <>
        <Header
          onDashboard={() => {
            window.location.href = "/dashboard";
          }}
        />
        <main className="category-products-page category-detail-page">
          <a className="detail-back" href="/categories">
            &lt;-- All categories
          </a>
          <div className="category-page-heading">
            <div>
              <h1>{selected?.name || "Category"}</h1>
            </div>
          </div>
          <div className="product-grid">
            {pageProducts.map((product) => (
              <ProductCard
                key={product._id || product.name}
                product={product}
                onInquire={() => { }}
              />
            ))}
          </div>
          {productsLoading ? (
            <div className="loading-region"><Loader /></div>
          ) : selected && pageProducts.length === 0 ? (
            <div className="empty">
              No active products in this category yet.
            </div>
          ) : null}
        </main>
        <GlobalFooter />
      </>
    );
  return (
    <>
      <Header
        onDashboard={() => {
          window.location.href = "/dashboard";
        }}
      />
      <main className="categories-page category-index-page">
        <div className="category-page-heading">
          <div>
            <h1>Shop by category.</h1>
          </div>
        </div>
        {loading ? (
          <div className="loading-region"><Loader /></div>
        ) : (
          <div className="category-circle-grid">
            {categoryData.map((category) => (
              <a
                className="category-circle-item"
                href={`/categories/${category.slug}`}
                key={category._id}
              >
                <span className="category-circle">
                  {category.image && (
                    <img src={mediaUrl(category.image)} alt="" />
                  )}
                </span>
                <strong>{category.name}</strong>
              </a>
            ))}
          </div>
        )}
      </main>
      <GlobalFooter />
    </>
  );
}

function ProductCard({ product, onInquire }) {
  return (
    <article
      className="product-card"
      onMouseEnter={() => prefetchJson(`/products/${product._id}`, 60000)}
      onClick={() => navigateTo(`/products/${product._id}`)}
    >
      <div className="product-image">
        <img
          src={mediaUrl(product.image)}
          alt={product.name}
          fetchPriority="high"
        />
        <span className={`product-tag ${product.color}`}>{product.tag}</span>
      </div>
      <div className="product-info">
        <div className="product-category">{product.category}</div>
        <h3>{product.title || product.name}</h3>
        <div className="product-meta">
          <span>MOQ {product.moq}</span>
          <strong>From {formatPrice(product.price)}</strong>
        </div>
        <button
          className="inquire-link"
          onClick={(event) => {
            event.stopPropagation();
            dispatchProductInquiry(product);
          }}
        >
          Send inquiry <ArrowRight size={15} />
        </button>
      </div>
    </article>
  );
}

function ProductsPage() {
  const [pageProducts, setPageProducts] = useState([]);
  const [categoryOptions, setCategoryOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState("All products");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [sentinel, setSentinel] = useState(null);
  const catalogRequestIdRef = useRef(0);
  const pageRequestIdRef = useRef(0);
  const paginationInFlightRef = useRef(false);
  const recoveryTimerRef = useRef(null);
  const recoveryAttemptRef = useRef(0);

  const loadPage = async (nextPage = 1, append = false, catalogRequestId = catalogRequestIdRef.current) => {
    const pageRequestId = ++pageRequestIdRef.current;
    const categoryQuery = filter === "All products" ? "" : `&category=${encodeURIComponent(filter)}`;
    const searchQuery = query.trim() ? `&search=${encodeURIComponent(query.trim())}` : "";
    const productResult = await getJson(`/products?sort=hot-selling&limit=12&page=${nextPage}${categoryQuery}${searchQuery}`);
    if (catalogRequestId !== catalogRequestIdRef.current || pageRequestId !== pageRequestIdRef.current)
      return productResult;
    const items = productResult.data || [];
    setPageProducts((current) => append ? [...current, ...items] : items);
    setHasMore(Boolean(productResult.pages && nextPage < productResult.pages));
    setPage(productResult.page || nextPage);
    return productResult;
  };

  const load = async () => {
    const requestId = ++catalogRequestIdRef.current;
    pageRequestIdRef.current += 1;
    paginationInFlightRef.current = false;
    setLoading(true);
    setLoadingMore(false);
    const [productResult, categoryResult] = await Promise.allSettled([
      loadPage(1, false, requestId),
      getJson("/categories?page=1&limit=100", 30000),
    ]);
    if (requestId !== catalogRequestIdRef.current) return;
    let failed = false;
    if (productResult.status === "fulfilled") {
      setHasMore(Boolean(productResult.value.pages && productResult.value.page < productResult.value.pages));
    } else {
      failed = true;
    }
    if (categoryResult.status === "fulfilled")
      setCategoryOptions(categoryResult.value.data || []);
    else failed = true;
    if (failed) scheduleRecovery();
    else recoveryAttemptRef.current = 0;
    setLoading(false);
  };

  const scheduleRecovery = () => {
    if (recoveryTimerRef.current) return;
    const attempt = recoveryAttemptRef.current;
    const delay = [3000, 7000, 15000, 30000][Math.min(attempt, 3)];
    recoveryAttemptRef.current = Math.min(attempt + 1, 4);
    console.warn(`[products] recovery_retry attempt=${attempt + 1} delayMs=${delay}`);
    recoveryTimerRef.current = window.setTimeout(() => {
      recoveryTimerRef.current = null;
      void load();
    }, delay);
  };

  useEffect(() => {
    void load();
    const refresh = () => {
      void load();
    };
    const onStorage = (event) => {
      if (event.key === catalogChangeKey) refresh();
    };
    window.addEventListener("storage", onStorage);
    catalogSyncChannel?.addEventListener("message", refresh);
    return () => {
      catalogRequestIdRef.current += 1;
      pageRequestIdRef.current += 1;
      paginationInFlightRef.current = false;
      window.removeEventListener("storage", onStorage);
      catalogSyncChannel?.removeEventListener("message", refresh);
      if (recoveryTimerRef.current) {
        window.clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
    };
  }, [filter, query]);

  useEffect(() => {
    if (!sentinel || !hasMore || loadingMore) return undefined;
    const requestId = catalogRequestIdRef.current;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && requestId === catalogRequestIdRef.current && !paginationInFlightRef.current) {
        paginationInFlightRef.current = true;
        setLoadingMore(true);
        loadPage(page + 1, true, requestId)
          .catch(() => { })
          .finally(() => {
            if (requestId === catalogRequestIdRef.current) {
              paginationInFlightRef.current = false;
              setLoadingMore(false);
            }
          });
      }
    }, { rootMargin: "160px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel, page, hasMore, loading, loadingMore, filter, query]);

  const filtered = pageProducts.filter(
    (product) =>
      (filter === "All products" || product.category === filter) &&
      product.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <Header
        onDashboard={() => {
          window.location.href = "/dashboard";
        }}
      />
      <main className="category-products-page products-page">
        <div className="category-page-heading">
          <div>
            <h1>Explore marketplace products.</h1>
          </div>
        </div>
        {loading ? (
          <div className="loading-region"><Loader /></div>
        ) : (
          <>
            <div className="product-grid">
              {filtered.map((product) => (
                <ProductCard
                  key={product._id || product.name}
                  product={product}
                  onInquire={() => { }}
                />
              ))}
            </div>
            {loadingMore && (
              <div className="loading-region"><Loader /></div>
            )}
            {!loadingMore && hasMore && <div ref={setSentinel} aria-hidden="true" style={{ height: 1 }} />}
            {filtered.length === 0 && !loadingMore && (
              <div className="empty">
                No matching products yet. Try a broader search.
              </div>
            )}
          </>
        )}
      </main>
      <GlobalFooter />
    </>
  );
}

function ProductDetail({ productId }) {
  const [product, setProduct] = useState(null);
  const [productLoading, setProductLoading] = useState(true);
  const [relatedProducts, setRelatedProducts] = useState([]);
  const [selectedImage, setSelectedImage] = useState(0);
  const [selectedTier, setSelectedTier] = useState(0);
  const [notice, setNotice] = useState("");
  const [zoomActive, setZoomActive] = useState(false);
  const mediaFrameRef = useRef(null);
  useEffect(() => {
    getJson(`/products/${productId}`, 60000)
      .then((item) => setProduct(item))
      .catch(() => setProduct(null))
      .finally(() => setProductLoading(false));
  }, [productId]);
  useEffect(() => {
    if (!product) {
      setRelatedProducts([]);
      return;
    }
    getJson(`/products?category=${encodeURIComponent(product.category || '')}&sort=hot-selling&limit=12&page=1`)
      .then((result) => {
        const currentId = String(product._id || productId);
        const available = (result.data || []).filter(
          (item) => String(item._id) !== currentId,
        );
        const sameCategory = available.filter(
          (item) => item.category === product.category,
        );
        const otherProducts = available.filter(
          (item) => item.category !== product.category,
        );
        setRelatedProducts([...sameCategory, ...otherProducts].slice(0, 5));
      })
      .catch(() => setRelatedProducts([]));
  }, [product, productId]);
  if (productLoading)
    return (
      <>
        <Header
          onDashboard={() => {
            window.location.href = "/dashboard";
          }}
        />
        <main className="loading-region detail-loading"><Loader /></main>
      </>
    );
  if (!product)
    return (
      <>
        <Header
          onDashboard={() => {
            window.location.href = "/dashboard";
          }}
        />
        <main className="empty-workspace">
          <h2>Product details unavailable</h2>
          <p>This product could not be loaded from the marketplace.</p>
        </main>
      </>
    );
  const images = (
    product.images?.length ? product.images : [product.image]
  )
    .slice(0, 3)
    .map(mediaUrl);
  const tiers = productTiers(product).map((tier) => ({
    ...tier,
    quantity: formatMoqRange(tier),
    price: formatPrice(tier.price),
  }));
  const media = [
    ...images.map((src) => ({ type: "image", src })),
    ...(product.video ? [{ type: "video", src: mediaUrl(product.video) }] : []),
  ];
  if (!tiers.length)
    return (
      <>
        <Header
          onDashboard={() => {
            window.location.href = "/dashboard";
          }}
        />
        <main className="empty-workspace">
          <h2>Product details unavailable</h2>
          <p>This product has no pricing tiers yet.</p>
        </main>
      </>
    );
  const selectedMedia = media[selectedImage] || media[0];
  const selectPreviousMedia = () => {
    setZoomActive(false);
    setSelectedImage((current) => (current - 1 + media.length) % media.length);
  };
  const selectNextMedia = () => {
    setZoomActive(false);
    setSelectedImage((current) => (current + 1) % media.length);
  };
  const updateZoomPosition = (event) => {
    if (selectedMedia.type !== "image" || !mediaFrameRef.current) return;
    const bounds = mediaFrameRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((event.clientX - bounds.left) / bounds.width) * 100));
    const y = Math.max(0, Math.min(100, ((event.clientY - bounds.top) / bounds.height) * 100));
    mediaFrameRef.current.style.setProperty("--zoom-x", `${x}%`);
    mediaFrameRef.current.style.setProperty("--zoom-y", `${y}%`);
    setZoomActive(true);
  };
  const resetZoom = () => setZoomActive(false);
  const productContext = {
    productId: String(product._id || productId),
    title: product.title || product.name,
    image: selectedMedia.type === "image" ? selectedMedia.src : images[0],
    selectedMoq: tiers[selectedTier].quantity,
  };
  const openProductLiveChat = () => {
    dispatchProductLiveChat(product, productId, productContext.image, productContext.selectedMoq);
  };
  return (
    <>
      <Header
        productContext={productContext}
        onDashboard={() => {
          window.location.href = "/dashboard";
        }}
      />
      <main className="detail-page">
        <a className="detail-back" href="/products">
          &lt;-- Back to products
        </a>
        <div className="detail-layout">
          <section className="gallery">
            <div className="thumbnail-list">
              {media.map((item, index) => (
                <button
                  key={item.src}
                  className={
                    selectedImage === index ? "thumbnail selected" : "thumbnail"
                  }
                  onClick={() => {
                    setZoomActive(false);
                    setSelectedImage(index);
                  }}
                  aria-label={
                    item.type === "video"
                      ? "Product video"
                      : `${product.name} view ${index + 1}`
                  }
                >
                  {item.type === "video" ? (
                    <span className="video-thumbnail">
                      <PlayIcon />
                    </span>
                  ) : (
                    <img
                      src={item.src}
                      alt={`${product.name} view ${index + 1}`}
                    />
                  )}
                </button>
              ))}
            </div>
            <div
              ref={mediaFrameRef}
              className={`main-product-image ${selectedMedia.type === "image" ? "image-active" : "video-active"} ${zoomActive && selectedMedia.type === "image" ? "is-zoomed" : ""
                }`}
              onPointerMove={updateZoomPosition}
              onPointerLeave={resetZoom}
            >
              {selectedMedia.type === "video" ? (
                <video
                  key={selectedMedia.src}
                  src={selectedMedia.src}
                  controls
                  playsInline
                />
              ) : (
                <img
                  key={selectedMedia.src}
                  src={selectedMedia.src}
                  alt={product.name}
                />
              )}
              {media.length > 1 && (
                <>
                  <button
                    type="button"
                    className="media-nav media-nav-previous"
                    onClick={selectPreviousMedia}
                    aria-label="Previous product media"
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <button
                    type="button"
                    className="media-nav media-nav-next"
                    onClick={selectNextMedia}
                    aria-label="Next product media"
                  >
                    <ChevronRight size={18} />
                  </button>
                </>
              )}
            </div>
          </section>
          <section className="detail-copy">
            <div className="eyebrow">
              <span>{product.category?.toUpperCase()}</span>
              <span className="detail-verified-indicator">
                <img src="/VERIFIED.png" alt="" />
                VERIFIED SUPPLIER
              </span>
            </div>
            <h1>{product.title || product.name}</h1>
            <p className="detail-description">
              {product.description ||
                product.shortDescription ||
                "A dependable sourcing option prepared for growing B2B collections."}
            </p>
            <div className="supplier-line">
              <span className="supplier-avatar">
                {(product.supplier || "OM").slice(0, 2).toUpperCase()}
              </span>
              <div>
                <small>Supplier</small>
                <strong>
                  {product.supplier || "Vendor Woo supplier network"}
                </strong>
              </div>
              <span className="verified">
                <ShieldCheck size={14} /> Verified
              </span>
            </div>
            <div className="detail-divider" />
            <div className="price-label">
              Tiered wholesale pricing <span>Price per piece</span>
            </div>
            <div className="price-display">
              {tiers[selectedTier].price}
              <small> / piece</small>
            </div>
            <div className="tier-label">Order quantity</div>
            <div className="tier-grid">
              {tiers.map((tier, index) => (
                <button
                  key={tier.quantity}
                  className={selectedTier === index ? "tier selected" : "tier"}
                  onClick={() => setSelectedTier(index)}
                >
                  <strong>{tier.quantity}</strong>
                  <small>{tier.price} / piece</small>
                </button>
              ))}
            </div>
            <div className="detail-actions">
              <button
                className="button primary"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent("omni-product-inquiry", {
                    detail: {
                      productId: String(product._id || productId),
                      title: product.title || product.name,
                      image: images[0] || "",
                      selectedMoq: tiers[selectedTier].quantity,
                    },
                  }))
                }
              >
                <MessageCircle size={17} /> Send inquiry
              </button>
              <button
                className="button detail-chat"
                onClick={openProductLiveChat}
              >
                <MessageCircle size={17} /> Live chat
              </button>
            </div>
            {notice && <div className="dashboard-notice">{notice}</div>}
          </section>
        </div>
        {relatedProducts.length > 0 && (
          <section className="related-products" aria-labelledby="related-products-title">
            <div className="category-page-heading">
              <div>
                <div className="eyebrow">FROM THE SAME COLLECTION</div>
                <h2 id="related-products-title">Related products.</h2>
                <p>Explore more products from this category.</p>
              </div>
            </div>
            <div className="product-grid">
              {relatedProducts.map((relatedProduct) => (
                <ProductCard
                  key={relatedProduct._id || relatedProduct.name}
                  product={relatedProduct}
                  onInquire={() => { }}
                />
              ))}
            </div>
          </section>
        )}
      </main>
    </>
  );
}

function PlayIcon() {
  return <span className="video-play-icon">&gt;</span>;
}

function LegacyProductDetail({ productId }) {
  const fallback =
    products.find((item) => item._id === productId) || products[0];
  const [product, setProduct] = useState(fallback);
  const [selectedImage, setSelectedImage] = useState(0);
  const [selectedTier, setSelectedTier] = useState(0);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    fetch(`${API_URL}/products/${productId}`)
      .then((response) => (response.ok ? response.json() : fallback))
      .then((item) => setProduct({ ...fallback, ...item }))
      .catch(() => { });
  }, [productId]);
  const images = (
    product.images?.length ? product.images : [product.image]
  ).map(mediaUrl);
  const tiers = productTiers(product).map((tier) => ({
    ...tier,
    quantity: formatMoqRange(tier),
    price: formatPrice(tier.price),
  }));
  if (!tiers.length)
    return (
      <>
        <Header
          onDashboard={() => {
            window.location.href = "/dashboard";
          }}
        />
        <main className="empty-workspace">
          <h2>Product details unavailable</h2>
          <p>This product has no pricing tiers yet.</p>
        </main>
        <GlobalFooter />
      </>
    );
  return (
    <>
      <Header
        onDashboard={() => {
          window.location.href = "/dashboard";
        }}
      />
      <main className="detail-page">
        <a className="detail-back" href="/products">
          &lt;-- Back to products
        </a>
        <div className="detail-layout">
          <section className="gallery">
            <div className="thumbnail-list">
              {images.map((image, index) => (
                <button
                  key={image}
                  className={
                    selectedImage === index ? "thumbnail selected" : "thumbnail"
                  }
                  onClick={() => setSelectedImage(index)}
                >
                  <img src={image} alt={`${product.name} view ${index + 1}`} />
                </button>
              ))}
            </div>
            <div className="main-product-image">
              <img
                key={images[selectedImage]}
                src={images[selectedImage]}
                alt={product.name}
              />
            </div>
          </section>
          <section className="detail-copy">
            <div className="eyebrow">
              <span>{product.category?.toUpperCase()}</span>
              <span className="detail-verified-indicator">
                <img src="/VERIFIED.png" alt="" />
                VERIFIED SUPPLIER
              </span>
            </div>
            <h1>{product.name}</h1>
            <p className="detail-description">
              {product.description ||
                "A dependable sourcing option prepared for growing B2B collections."}
            </p>
            <div className="supplier-line">
              <span className="supplier-avatar">
                {(product.supplier || "OM").slice(0, 2).toUpperCase()}
              </span>
              <div>
                <small>Supplier</small>
                <strong>
                  {product.supplier || "Vendor Woo supplier network"}
                </strong>
              </div>
              <span className="verified">
                <ShieldCheck size={14} /> Verified
              </span>
            </div>
            <div className="detail-divider" />
            <div className="price-label">
              Tiered wholesale pricing <span>Price per piece</span>
            </div>
            <div className="price-display">
              {tiers[selectedTier].price}
              <small> / piece</small>
            </div>
            <div className="tier-label">Order quantity</div>
            <div className="tier-grid">
              {tiers.map((tier, index) => (
                <button
                  key={tier.quantity}
                  className={selectedTier === index ? "tier selected" : "tier"}
                  onClick={() => setSelectedTier(index)}
                >
                  <strong>{tier.quantity}</strong>
                  <small>{tier.price} / piece</small>
                </button>
              ))}
            </div>
            <div className="detail-actions">
              <button
                className="button primary"
                onClick={() =>
                  setNotice("Inquiry started. A supplier will respond shortly.")
                }
              >
                <MessageCircle size={17} /> Send inquiry
              </button>
              <button
                className="button detail-chat"
                onClick={() => dispatchProductLiveChat(product, productId, images[0], tiers[selectedTier].quantity)}
              >
                <MessageCircle size={17} /> Live chat
              </button>
            </div>
            {notice && (
              <div className="detail-notice">
                <Check size={16} /> {notice}
              </div>
            )}
          </section>
        </div>
      </main>
    </>
  );
}

function Dashboard({ onClose }) {
  return (
    <div className="dashboard-panel">
      <div className="dash-top">
        <div>
          <div className="eyebrow">ACCOUNT OVERVIEW</div>
          <h2>Your sourcing desk</h2>
        </div>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close dashboard"
        >
          <X size={19} />
        </button>
      </div>
      <div className="dash-grid">
        <div className="stat">
          <span>Open inquiries</span>
          <strong>12</strong>
          <small>+3 this week</small>
        </div>
        <div className="stat">
          <span>Saved suppliers</span>
          <strong>28</strong>
          <small>4 recently active</small>
        </div>
        <div className="stat">
          <span>Active orders</span>
          <strong>06</strong>
          <small>Across 3 categories</small>
        </div>
      </div>
      <div className="activity">
        <div className="activity-heading">
          <h3>Recent activity</h3>
          <button>
            View all <ArrowRight size={14} />
          </button>
        </div>
        <div className="activity-row">
          <span className="activity-icon coral">
            <MessageCircle size={16} />
          </span>
          <div>
            <strong>New reply from Atlas Mobility</strong>
            <small>Compact EV charging kit | 18 min ago</small>
          </div>
          <span className="unread" />
        </div>
        <div className="activity-row">
          <span className="activity-icon teal">
            <Package size={16} />
          </span>
          <div>
            <strong>Sample order dispatched</strong>
            <small>Organic cotton nursery set | Yesterday</small>
          </div>
        </div>
      </div>
    </div>
  );
}

function EmployeeViewModal({ employee, onClose }) {
  return (
    <div
      className="contact-overlay"
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="contact-modal vendor-view-modal">
        <div className="modal-heading">
          <div>
            <div className="eyebrow">EMPLOYEE DETAILS</div>
            <h2>{employee.fullName}</h2>
          </div>
          <button
            className="modal-close"
            onClick={onClose}
            aria-label="Close employee details"
          >
            <X size={18} />
          </button>
        </div>
        <div className="vendor-detail-fields">
          <span>
            <strong>Full Name</strong>
            {employee.fullName}
          </span>
          <span>
            <strong>Father's Name</strong>
            {employee.fatherName}
          </span>
          <span>
            <strong>CNIC</strong>
            {employee.cnic}
          </span>
          <span>
            <strong>Phone Number</strong>
            {employee.phoneNumber}
          </span>
          <span>
            <strong>Email Address</strong>
            {employee.emailAddress}
          </span>
          <span>
            <strong>Address</strong>
            {employee.address}
          </span>
          <span>
            <strong>Designation</strong>
            {employee.designation}
          </span>
        </div>
        <button className="button quiet" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
function DeleteEmployeeModal({
  employee,
  deleting,
  error,
  onCancel,
  onConfirm,
}) {
  return (
    <div
      className="contact-overlay category-overlay"
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !deleting) onCancel();
      }}
    >
      <div className="contact-modal delete-category-modal">
        <div className="modal-heading">
          <div>
            <div className="eyebrow">EMPLOYEE MANAGEMENT</div>
            <h2>Delete employee?</h2>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onCancel}
            disabled={deleting}
            aria-label="Close delete confirmation"
          >
            <X size={18} />
          </button>
        </div>
        <p className="delete-category-copy">
          Are you sure you want to delete this employee? This action cannot be
          undone.
        </p>
        <div className="delete-category-name">{employee.fullName}</div>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button quiet"
            onClick={onCancel}
            disabled={deleting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button danger"
            onClick={onConfirm}
            disabled={deleting}
          >
            {deleting ? <Loader /> : <>Delete <Trash2 size={15} /></>}
          </button>
        </div>
      </div>
    </div>
  );
}
function EmployeeForm({ onSubmit, onCancel, employee }) {
  const [form, setForm] = useState(() =>
    employee
      ? {
        fullName: employee.fullName || "",
        fatherName: employee.fatherName || "",
        cnic: employee.cnic || "",
        phoneNumber: employee.phoneNumber || "",
        emailAddress: employee.emailAddress || "",
        password: "",
        confirmPassword: "",
        address: employee.address || "",
        designation: employee.designation || "Employee",
      }
      : {
        fullName: "",
        fatherName: "",
        cnic: "",
        phoneNumber: "",
        emailAddress: "",
        password: "",
        confirmPassword: "",
        address: "",
        designation: "Employee",
      },
  );
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const update = (field, value) =>
    setForm((current) => ({ ...current, [field]: value }));
  const submit = async (event) => {
    event.preventDefault();
    setError("");
    const values = Object.fromEntries(
      Object.entries(form).map(([key, value]) => [key, value.trim()]),
    );
    if (!employee && Object.values(values).some((value) => !value)) {
      setError("Complete all employee fields.");
      return;
    }
    if (
      employee &&
      Object.entries(values).some(
        ([key, value]) =>
          !value && !["password", "confirmPassword"].includes(key),
      )
    ) {
      setError("Complete all employee fields.");
      return;
    }
    if (
      (values.password || values.confirmPassword) &&
      values.password !== values.confirmPassword
    ) {
      setError("Passwords do not match.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.emailAddress)) {
      setError("Enter a valid email address.");
      return;
    }
    if (!/^\+?[\d\s().-]{7,20}$/.test(values.phoneNumber)) {
      setError("Enter a valid phone number.");
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(values);
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSubmitting(false);
    }
  };
  const field = (name, label, type = "text", props = {}) => (
    <label>
      {label}
      {type === "password" ? (
        <PasswordField
          value={form[name]}
          onChange={(event) => update(name, event.target.value)}
          required={!employee}
          {...props}
        />
      ) : (
        <input
          required={
            !employee || !["password", "confirmPassword"].includes(name)
          }
          type={type}
          value={form[name]}
          onChange={(event) => update(name, event.target.value)}
          {...props}
        />
      )}
    </label>
  );
  return (
    <div
      className="contact-overlay category-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="employee-form-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onCancel();
      }}
    >
      <form
        className="contact-modal category-form employee-form"
        onSubmit={submit}
        noValidate
      >
        <div className="modal-heading">
          <div>
            <div className="eyebrow">EMPLOYEE SETUP</div>
            <h2 id="employee-form-title">
              {employee ? "Edit employee" : "Add employee"}
            </h2>
            <p>
              {employee
                ? "Update this employee record."
                : "Create an employee for your marketplace workspace."}
            </p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onCancel}
            disabled={submitting}
            aria-label="Close employee form"
          >
            <X size={18} />
          </button>
        </div>
        {field("fullName", "Full Name", "text", {
          placeholder: "Enter the full name",
        })}
        {field("fatherName", "Father's Name", "text", {
          placeholder: "Enter the father's name",
        })}
        {field("cnic", "CNIC", "text", { placeholder: "Enter the CNIC" })}
        {field("phoneNumber", "Phone Number", "tel", {
          placeholder: "Enter the phone number",
          inputMode: "tel",
        })}
        {field("emailAddress", "Email Address", "email", {
          placeholder: "Enter the email address",
        })}
        {field("password", "Password", "password", {
          placeholder: employee
            ? "Leave blank to keep current password"
            : "Enter the password",
        })}
        {field("confirmPassword", "Confirm Password", "password", {
          placeholder: employee
            ? "Confirm a new password"
            : "Confirm the password",
        })}
        {field("address", "Address", "text", {
          placeholder: "Enter the address",
        })}
        <label>
          Designation
          <select
            required
            value={form.designation}
            onChange={(event) => update("designation", event.target.value)}
          >
            <option value="Admin">Admin</option>
            <option value="Employee">Employee</option>
          </select>
        </label>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button quiet"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={submitting}
          >
            {submitting
              ? <Loader />
              : employee
                ? "Update employee"
                : "Save employee"}{" "}
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}
function Employees({ data, onPage }) {
  const [viewEmployee, setViewEmployee] = useState(null);
  const [editEmployee, setEditEmployee] = useState(null);
  const [deleteEmployee, setDeleteEmployee] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [searchPage, setSearchPage] = useState(1);
  const normalizedSearch = searchTerm.trim().toLowerCase();
  useEffect(() => {
    setSearchPage(1);
  }, [searchTerm]);
  const pageSize = data?.limit || 50;
  const filteredEmployees = !normalizedSearch
    ? (data?.data || [])
    : (data?.data || []).filter((employee) =>
      String(employee.fullName || "").toLowerCase().includes(normalizedSearch),
    );
  const totalPages = Math.max(1, Math.ceil(filteredEmployees.length / pageSize));
  const currentPage = normalizedSearch ? Math.min(searchPage, totalPages) : data?.page || 1;
  const visibleRows = normalizedSearch
    ? filteredEmployees.slice((currentPage - 1) * pageSize, currentPage * pageSize)
    : data?.data || [];
  const showPagination = normalizedSearch ? totalPages > 1 : data?.pages > 1;
  const handlePageChange = (nextPage) => {
    if (normalizedSearch) {
      setSearchPage(Math.max(1, Math.min(nextPage, totalPages)));
      return;
    }
    onPage(nextPage);
  };
  const request = async (path, options = {}) => {
    const response = await fetchWithRecovery(`${API_URL}${path}`, {
      cache: "no-store",
      ...options,
      headers: {
        "Content-Type": "application/json",
        "x-admin-key": "omni-dev-key",
        ...(options.headers || {}),
      },
    });
    return response.status === 204 ? null : parseResponse(response);
  };
  const updateEmployee = async (employee) => {
    const result = await request(`/employees/${editEmployee._id}`, {
      method: "PUT",
      body: JSON.stringify(employee),
    });
    setEditEmployee(null);
    setNotice("Employee updated successfully.");
    onPage(result);
  };
  const confirmDelete = async () => {
    if (!deleteEmployee) return;
    setDeleting(true);
    try {
      await request(`/employees/${deleteEmployee._id}`, { method: "DELETE" });
      setDeleteEmployee(null);
      setNotice("Employee deleted.");
      onPage();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setDeleting(false);
    }
  };
  if (!data) return <div className="loading-region"><Loader /></div>;
  return (
    <>
      {notice && <div className="dashboard-notice">{notice}</div>}
      <section className="data-panel table-panel employee-table">
        <div className="panel-tools product-panel-tools">
          <label className="search-field product-search-field">
            <Search size={16} />
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search employees"
              aria-label="Search employees by name"
            />
          </label>
        </div>
        {!normalizedSearch && !data.data?.length ? (
          <div className="empty-workspace">
            <span>
              <Users size={22} />
            </span>
            <h2>No employees yet</h2>
            <p>Add your first employee to get started.</p>
          </div>
        ) : normalizedSearch && !filteredEmployees.length ? (
          <div className="empty-workspace">
            <span>
              <Search size={22} />
            </span>
            <h2>No employees found</h2>
            <p>Try a different employee name.</p>
          </div>
        ) : (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Full name</th>
                    <th>Designation</th>
                    <th>Phone number</th>
                    <th>Email address</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((employee) => (
                    <tr key={employee._id}>
                      <td>{employee.fullName}</td>
                      <td>{employee.designation}</td>
                      <td>{employee.phoneNumber}</td>
                      <td>{employee.emailAddress}</td>
                      <td>
                        <div className="employee-actions">
                          <button
                            className="table-action"
                            onClick={() => setViewEmployee(employee)}
                          >
                            View
                          </button>
                          <button
                            className="table-action category-edit"
                            onClick={() => setEditEmployee(employee)}
                          >
                            <Edit3 size={14} /> Edit
                          </button>
                          <button
                            className="table-action category-delete"
                            onClick={() => setDeleteEmployee(employee)}
                          >
                            <Trash2 size={14} /> Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {showPagination && (
              <div className="pagination">
                <button
                  disabled={currentPage <= 1}
                  onClick={() => handlePageChange(currentPage - 1)}
                  aria-label="Previous page"
                >
                  <ChevronLeft size={16} />
                </button>
                <span>
                  Page {currentPage} of {normalizedSearch ? totalPages : data.pages}
                </span>
                <button
                  disabled={currentPage >= (normalizedSearch ? totalPages : data.pages)}
                  onClick={() => handlePageChange(currentPage + 1)}
                  aria-label="Next page"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
          </>
        )}
      </section>
      {viewEmployee && (
        <EmployeeViewModal
          employee={viewEmployee}
          onClose={() => setViewEmployee(null)}
        />
      )}
      {editEmployee && (
        <EmployeeForm
          employee={editEmployee}
          onSubmit={updateEmployee}
          onCancel={() => setEditEmployee(null)}
        />
      )}
      {deleteEmployee && (
        <DeleteEmployeeModal
          employee={deleteEmployee}
          deleting={deleting}
          error={notice}
          onCancel={() => setDeleteEmployee(null)}
          onConfirm={confirmDelete}
        />
      )}
    </>
  );
}

function EmployeeDashboardPage() {
  const [data, setData] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const request = async (path, options = {}) => {
    const response = await fetch(`${API_URL}${path}`, {
      cache: "no-store",
      ...options,
      headers: {
        "Content-Type": "application/json",
        "x-admin-key": "omni-dev-key",
        ...(options.headers || {}),
      },
    });
    return response.status === 204 ? null : parseResponse(response);
  };
  const load = () => {
    request("/employees?page=1&limit=50")
      .then(setData)
      .catch((error) => setNotice(error.message));
  };
  useEffect(() => {
    load();
  }, []);
  const createEmployee = async (employee) => {
    const result = await request("/employees", {
      method: "POST",
      body: JSON.stringify(employee),
    });
    setModalOpen(false);
    setNotice("Employee added successfully.");
    setData((current) =>
      current
        ? {
          ...current,
          data: [result, ...(current.data || [])],
          total: (current.total || 0) + 1,
        }
        : current,
    );
    load();
  };
  return (
    <div className="dashboard-app">
      <aside className="dashboard-sidebar">
        <a className="brand sidebar-brand" href="/">
          Vendor <span>Woo</span>
        </a>
        <div className="sidebar-label">MAIN</div>
        <a className="sidebar-link" href="/dashboard">
          <LayoutDashboard size={17} />
          Overview
        </a>
        <a className="sidebar-link" href="/dashboard/product">
          <Package size={17} />
          Products
        </a>
        <a className="sidebar-link" href="/dashboard/category">
          <Tag size={17} />
          Categories
        </a>
        <a className="sidebar-link" href="/dashboard/customer">
          <Users size={17} />
          Customers
        </a>
        <a className="sidebar-link" href="/dashboard/vendor">
          <Users size={17} />
          Vendors
        </a>
        <a className="sidebar-link active" href="/dashboard/employee">
          <Users size={17} />
          Employees
        </a>
        <a className="sidebar-link" href="/dashboard/inquiry">
          <MessageCircle size={17} />
          Inquiries
        </a>
        <div className="sidebar-label">MANAGEMENT</div>
        <a className="sidebar-link" href="/dashboard/message">
          <Users size={17} />
          Messages
        </a>
        <a className="sidebar-link" href="/dashboard/profile">
          <Users size={17} />
          Profile
        </a>
        <a className="sidebar-link" href="/dashboard/setting">
          <Settings size={17} />
          Settings
        </a>
        <a className="sidebar-back" href="/">
          &lt;-- Back to marketplace
        </a>
      </aside>
      <div className="dashboard-main">
        <DashboardTopbar title="Employees" />
        <main className="dashboard-content">
          {notice && <div className="dashboard-notice">{notice}</div>}
          <div className="dashboard-actions-row">
            <button
              className="button primary"
              onClick={() => {
                setNotice("");
                setModalOpen(true);
              }}
            >
              <Plus size={16} /> Add employee
            </button>
          </div>
          <Employees data={data} onPage={() => load()} />
        </main>
      </div>
      {modalOpen && (
        <EmployeeForm
          onSubmit={createEmployee}
          onCancel={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}

function CustomerViewModal({ customer, onClose }) {
  return (
    <div
      className="contact-overlay"
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="contact-modal vendor-view-modal">
        <div className="modal-heading">
          <div>
            <div className="eyebrow">CUSTOMER DETAILS</div>
            <h2>{customer.customerName}</h2>
          </div>
          <button
            className="modal-close"
            onClick={onClose}
            aria-label="Close customer details"
          >
            <X size={18} />
          </button>
        </div>
        <div className="vendor-detail-fields">
          <span>
            <strong>Customer Name</strong>
            {customer.customerName}
          </span>
          <span>
            <strong>Phone Number</strong>
            {customer.phoneNumber}
          </span>
          <span>
            <strong>Email Address</strong>
            {customer.emailAddress}
          </span>
        </div>
        <button className="button quiet" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
function DeleteCustomerModal({
  customer,
  deleting,
  error,
  onCancel,
  onConfirm,
}) {
  return (
    <div
      className="contact-overlay category-overlay"
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !deleting) onCancel();
      }}
    >
      <div className="contact-modal delete-category-modal">
        <div className="modal-heading">
          <div>
            <div className="eyebrow">CUSTOMER MANAGEMENT</div>
            <h2>Delete customer?</h2>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onCancel}
            disabled={deleting}
            aria-label="Close delete confirmation"
          >
            <X size={18} />
          </button>
        </div>
        <p className="delete-category-copy">
          Are you sure you want to delete this customer? This action cannot be
          undone.
        </p>
        <div className="delete-category-name">{customer.customerName}</div>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button quiet"
            onClick={onCancel}
            disabled={deleting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button danger"
            onClick={onConfirm}
            disabled={deleting}
          >
            {deleting ? <Loader /> : <>Delete <Trash2 size={15} /></>}
          </button>
        </div>
      </div>
    </div>
  );
}
function CustomerForm({ onSubmit, onCancel, customer }) {
  const [form, setForm] = useState(() =>
    customer
      ? {
        customerName: customer.customerName || "",
        phoneNumber: customer.phoneNumber || "",
        emailAddress: customer.emailAddress || "",
      }
      : { customerName: "", phoneNumber: "", emailAddress: "" },
  );
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const update = (field, value) =>
    setForm((current) => ({ ...current, [field]: value }));
  const submit = async (event) => {
    event.preventDefault();
    setError("");
    const values = Object.fromEntries(
      Object.entries(form).map(([key, value]) => [key, value.trim()]),
    );
    if (Object.values(values).some((value) => !value)) {
      setError("Complete all customer fields.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.emailAddress)) {
      setError("Enter a valid email address.");
      return;
    }
    if (!/^\+?[\d\s().-]{7,20}$/.test(values.phoneNumber)) {
      setError("Enter a valid phone number.");
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(values);
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div
      className="contact-overlay category-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="customer-form-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onCancel();
      }}
    >
      <form
        className="contact-modal category-form customer-form"
        onSubmit={submit}
        noValidate
      >
        <div className="modal-heading">
          <div>
            <div className="eyebrow">CUSTOMER SETUP</div>
            <h2 id="customer-form-title">
              {customer ? "Edit customer" : "Add customer"}
            </h2>
            <p>
              {customer
                ? "Update this customer record."
                : "Add a customer to your marketplace workspace."}
            </p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onCancel}
            disabled={submitting}
            aria-label="Close customer form"
          >
            <X size={18} />
          </button>
        </div>
        <label>
          Customer Name
          <input
            required
            value={form.customerName}
            onChange={(event) => update("customerName", event.target.value)}
            placeholder="Enter the customer name"
          />
        </label>
        <label>
          Phone Number
          <input
            required
            value={form.phoneNumber}
            onChange={(event) => update("phoneNumber", event.target.value)}
            placeholder="Enter the phone number"
            inputMode="tel"
          />
        </label>
        <label>
          Email Address
          <input
            required
            type="email"
            value={form.emailAddress}
            onChange={(event) => update("emailAddress", event.target.value)}
            placeholder="Enter the email address"
          />
        </label>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button quiet"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={submitting}
          >
            {submitting
              ? <Loader />
              : customer
                ? "Update customer"
                : "Save customer"}{" "}
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}
function Customers({ data, onPage }) {
  const [viewCustomer, setViewCustomer] = useState(null);
  const [editCustomer, setEditCustomer] = useState(null);
  const [deleteCustomer, setDeleteCustomer] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [searchPage, setSearchPage] = useState(1);
  const normalizedSearch = searchTerm.trim().toLowerCase();
  useEffect(() => {
    setSearchPage(1);
  }, [searchTerm]);
  const pageSize = data?.limit || 50;
  const filteredCustomers = !normalizedSearch
    ? (data?.data || [])
    : (data?.data || []).filter((customer) => {
      const haystack = [customer.customerName, customer.phoneNumber, customer.emailAddress]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedSearch);
    });
  const totalPages = Math.max(1, Math.ceil(filteredCustomers.length / pageSize));
  const currentPage = normalizedSearch ? Math.min(searchPage, totalPages) : data?.page || 1;
  const visibleRows = normalizedSearch
    ? filteredCustomers.slice((currentPage - 1) * pageSize, currentPage * pageSize)
    : data?.data || [];
  const showPagination = normalizedSearch ? totalPages > 1 : data?.pages > 1;
  const handlePageChange = (nextPage) => {
    if (normalizedSearch) {
      setSearchPage(Math.max(1, Math.min(nextPage, totalPages)));
      return;
    }
    onPage(nextPage);
  };
  const request = async (path, options = {}) => {
    const response = await fetch(`${API_URL}${path}`, {
      cache: "no-store",
      ...options,
      headers: {
        "Content-Type": "application/json",
        "x-admin-key": "omni-dev-key",
        ...(options.headers || {}),
      },
    });
    return response.status === 204 ? null : parseResponse(response);
  };
  const updateCustomer = async (customer) => {
    const result = await request(`/customers/${editCustomer._id}`, {
      method: "PUT",
      body: JSON.stringify(customer),
    });
    setEditCustomer(null);
    setNotice("Customer updated successfully.");
    onPage(result);
  };
  const confirmDelete = async () => {
    if (!deleteCustomer) return;
    setDeleting(true);
    try {
      await request(`/customers/${deleteCustomer._id}`, { method: "DELETE" });
      setDeleteCustomer(null);
      setNotice("Customer deleted.");
      onPage();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setDeleting(false);
    }
  };
  if (!data) return <div className="loading-region"><Loader /></div>;
  return (
    <>
      {notice && <div className="dashboard-notice">{notice}</div>}
      <section className="data-panel table-panel customer-table">
        <div className="panel-tools product-panel-tools">
          <label className="search-field product-search-field">
            <Search size={16} />
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search customers"
              aria-label="Search customers by name"
            />
          </label>
        </div>
        {!normalizedSearch && !data.data?.length ? (
          <div className="empty-workspace">
            <span>
              <Users size={22} />
            </span>
            <h2>No customers yet</h2>
            <p>Add your first customer to get started.</p>
          </div>
        ) : normalizedSearch && !filteredCustomers.length ? (
          <div className="empty-workspace">
            <span>
              <Search size={22} />
            </span>
            <h2>No customers found</h2>
            <p>Try a different customer name or contact detail.</p>
          </div>
        ) : (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Customer name</th>
                    <th>Phone number</th>
                    <th>Email address</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((customer) => (
                    <tr key={customer._id}>
                      <td>{customer.customerName}</td>
                      <td>{customer.phoneNumber}</td>
                      <td>{customer.emailAddress}</td>
                      <td>
                        <div className="customer-actions">
                          <button
                            className="table-action"
                            onClick={() => setViewCustomer(customer)}
                          >
                            View
                          </button>
                          <button
                            className="table-action category-edit"
                            onClick={() => setEditCustomer(customer)}
                          >
                            <Edit3 size={14} /> Edit
                          </button>
                          <button
                            className="table-action category-delete"
                            onClick={() => setDeleteCustomer(customer)}
                          >
                            <Trash2 size={14} /> Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {showPagination && (
              <div className="pagination">
                <button
                  disabled={currentPage <= 1}
                  onClick={() => handlePageChange(currentPage - 1)}
                  aria-label="Previous page"
                >
                  <ChevronLeft size={16} />
                </button>
                <span>
                  Page {currentPage} of {normalizedSearch ? totalPages : data.pages}
                </span>
                <button
                  disabled={currentPage >= (normalizedSearch ? totalPages : data.pages)}
                  onClick={() => handlePageChange(currentPage + 1)}
                  aria-label="Next page"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
          </>
        )}
      </section>
      {viewCustomer && (
        <CustomerViewModal
          customer={viewCustomer}
          onClose={() => setViewCustomer(null)}
        />
      )}
      {editCustomer && (
        <CustomerForm
          customer={editCustomer}
          onSubmit={updateCustomer}
          onCancel={() => setEditCustomer(null)}
        />
      )}
      {deleteCustomer && (
        <DeleteCustomerModal
          customer={deleteCustomer}
          deleting={deleting}
          error={notice}
          onCancel={() => setDeleteCustomer(null)}
          onConfirm={confirmDelete}
        />
      )}
    </>
  );
}

function useEmployeeSidebarLink() {
  useEffect(() => {
    const sidebar = document.querySelector(".dashboard-sidebar");
    const vendorLink = sidebar?.querySelector('a[href="/dashboard/vendor"]');
    if (!vendorLink || sidebar.querySelector('a[href="/dashboard/employee"]'))
      return undefined;
    const employeeLink = vendorLink.cloneNode(true);
    employeeLink.href = "/dashboard/employee";
    employeeLink.classList.remove("active");
    const icon = employeeLink.querySelector("svg");
    employeeLink.replaceChildren(icon, document.createTextNode("Employees"));
    vendorLink.after(employeeLink);
    return () => employeeLink.remove();
  }, []);
}

function CustomerDashboardPage() {
  useEmployeeSidebarLink();
  const [data, setData] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const request = async (path, options = {}) => {
    const response = await fetch(`${API_URL}${path}`, {
      cache: "no-store",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
        ...(options.headers || {}),
      },
    });
    return response.status === 204 ? null : parseResponse(response);
  };
  const load = () => {
    request("/customers?page=1&limit=50")
      .then(setData)
      .catch((error) => setNotice(error.message));
  };
  useEffect(() => {
    load();
  }, []);
  const createCustomer = async (customer) => {
    const result = await request("/customers", {
      method: "POST",
      body: JSON.stringify(customer),
    });
    setModalOpen(false);
    setNotice("Customer added successfully.");
    setData((current) =>
      current
        ? {
          ...current,
          data: [result, ...(current.data || [])],
          total: (current.total || 0) + 1,
        }
        : current,
    );
    load();
  };
  return (
    <div className="dashboard-app">
      <aside className="dashboard-sidebar">
        <a className="brand sidebar-brand" href="/">
          Vendor <span>Woo</span>
        </a>
        <div className="sidebar-label">MAIN</div>
        <a className="sidebar-link" href="/dashboard">
          <LayoutDashboard size={17} />
          Overview
        </a>
        <a className="sidebar-link" href="/dashboard/product">
          <Package size={17} />
          Products
        </a>
        <a className="sidebar-link" href="/dashboard/category">
          <Tag size={17} />
          Categories
        </a>
        <a className="sidebar-link active" href="/dashboard/customer">
          <Users size={17} />
          Customers
        </a>
        <a className="sidebar-link" href="/dashboard/vendor">
          <Users size={17} />
          Vendors
        </a>
        <a className="sidebar-link" href="/dashboard/inquiry">
          <MessageCircle size={17} />
          Inquiries
        </a>
        <div className="sidebar-label">MANAGEMENT</div>
        <a className="sidebar-link" href="/dashboard/message">
          <Users size={17} />
          Messages
        </a>
        <a className="sidebar-link" href="/dashboard/profile">
          <Users size={17} />
          Profile
        </a>
        <a className="sidebar-link" href="/dashboard/setting">
          <Settings size={17} />
          Settings
        </a>
        <a className="sidebar-back" href="/">
          &lt;-- Back to marketplace
        </a>
      </aside>
      <div className="dashboard-main">
        <DashboardTopbar title="Customers" />
        <main className="dashboard-content">
          {notice && <div className="dashboard-notice">{notice}</div>}
          <Customers data={data} onPage={() => load()} />
        </main>
      </div>
      {modalOpen && (
        <CustomerForm
          onSubmit={createCustomer}
          onCancel={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}

function VendorDashboardPage() {
  useEmployeeSidebarLink();
  const [data, setData] = useState(null);
  const [categoryOptions, setCategoryOptions] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const request = async (path, options = {}) => {
    const response = await fetch(`${API_URL}${path}`, {
      cache: "no-store",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
        ...(options.headers || {}),
      },
    });
    return response.status === 204 ? null : parseResponse(response);
  };
  const load = () => {
    request("/vendors?page=1&limit=50")
      .then(setData)
      .catch((error) => setNotice(error.message));
  };
  useEffect(() => {
    load();
    getJson("/categories?page=1&limit=100", 30000)
      .then((result) => setCategoryOptions(result.data || []))
      .catch((error) => setNotice(error.message));
  }, []);
  const createVendor = async (vendor) => {
    const result = await request("/vendors", {
      method: "POST",
      body: JSON.stringify(vendor),
    });
    setModalOpen(false);
    setNotice("Vendor added successfully.");
    setData((current) =>
      current
        ? {
          ...current,
          data: [result, ...(current.data || [])],
          total: (current.total || 0) + 1,
        }
        : current,
    );
    load();
  };
  return (
    <div className="dashboard-app">
      <aside className="dashboard-sidebar">
        <a className="brand sidebar-brand" href="/">
          Vendor <span>Woo</span>
        </a>
        <div className="sidebar-label">MAIN</div>
        <a className="sidebar-link" href="/dashboard">
          <LayoutDashboard size={17} />
          Overview
        </a>
        <a className="sidebar-link" href="/dashboard/product">
          <Package size={17} />
          Products
        </a>
        <a className="sidebar-link" href="/dashboard/category">
          <Tag size={17} />
          Categories
        </a>
        <a className="sidebar-link" href="/dashboard/customer">
          <Users size={17} />
          Customers
        </a>
        <a className="sidebar-link active" href="/dashboard/vendor">
          <Users size={17} />
          Vendors
        </a>
        <a className="sidebar-link" href="/dashboard/inquiry">
          <MessageCircle size={17} />
          Inquiries
        </a>
        <div className="sidebar-label">MANAGEMENT</div>
        <a className="sidebar-link" href="/dashboard/message">
          <Users size={17} />
          Messages
        </a>
        <a className="sidebar-link" href="/dashboard/profile">
          <Users size={17} />
          Profile
        </a>
        <a className="sidebar-link" href="/dashboard/setting">
          <Settings size={17} />
          Settings
        </a>
        <a className="sidebar-back" href="/">
          &lt;-- Back to marketplace
        </a>
      </aside>
      <div className="dashboard-main">
        <DashboardTopbar title="Vendor" />
        <main className="dashboard-content">
          {notice && <div className="dashboard-notice">{notice}</div>}
          <div className="dashboard-actions-row">
            <button
              className="button primary"
              onClick={() => {
                setNotice("");
                setModalOpen(true);
              }}
            >
              <Plus size={16} /> Add vendor
            </button>
          </div>
          <Vendors data={data} onPage={() => load()} />
        </main>
      </div>
      {modalOpen && (
        <VendorForm
          categoryOptions={categoryOptions}
          onSubmit={createVendor}
          onCancel={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}

function CustomerDashboardContent() {
  const [data, setData] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const request = async (path, options = {}) => {
    const response = await fetch(`${API_URL}${path}`, {
      cache: "no-store",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
        ...(options.headers || {}),
      },
    });
    return response.status === 204 ? null : parseResponse(response);
  };
  const load = () => {
    request("/customers?page=1&limit=50")
      .then(setData)
      .catch((error) => setNotice(error.message));
  };
  useEffect(() => {
    load();
  }, []);
  const createCustomer = async (customer) => {
    const result = await request("/customers", {
      method: "POST",
      body: JSON.stringify(customer),
    });
    setModalOpen(false);
    setNotice("Customer added successfully.");
    setData((current) =>
      current
        ? {
          ...current,
          data: [result, ...(current.data || [])],
          total: (current.total || 0) + 1,
        }
        : current,
    );
    load();
  };
  return (
    <>
      {notice && <div className="dashboard-notice">{notice}</div>}
      <div className="dashboard-actions-row">
        <button
          className="button primary"
          onClick={() => {
            setNotice("");
            setModalOpen(true);
          }}
        >
          <Plus size={16} /> Add customer
        </button>
      </div>
      <Customers data={data} onPage={load} />
      {modalOpen && (
        <CustomerForm
          onSubmit={createCustomer}
          onCancel={() => setModalOpen(false)}
        />
      )}
    </>
  );
}

function VendorDashboardContent() {
  const [data, setData] = useState(null);
  const [categoryOptions, setCategoryOptions] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const request = async (path, options = {}) => {
    const response = await fetch(`${API_URL}${path}`, {
      cache: "no-store",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
        ...(options.headers || {}),
      },
    });
    return response.status === 204 ? null : parseResponse(response);
  };
  const load = () => {
    request("/vendors?page=1&limit=50")
      .then(setData)
      .catch((error) => setNotice(error.message));
  };
  useEffect(() => {
    load();
    getJson("/categories?page=1&limit=100", 30000)
      .then((result) => setCategoryOptions(result.data || []))
      .catch((error) => setNotice(error.message));
  }, []);
  const createVendor = async (vendor) => {
    const result = await request("/vendors", {
      method: "POST",
      body: JSON.stringify(vendor),
    });
    setModalOpen(false);
    setNotice("Vendor added successfully.");
    setData((current) =>
      current
        ? {
          ...current,
          data: [result, ...(current.data || [])],
          total: (current.total || 0) + 1,
        }
        : current,
    );
    load();
  };
  return (
    <>
      {notice && <div className="dashboard-notice">{notice}</div>}
      <div className="dashboard-actions-row">
        <button
          className="button primary"
          onClick={() => {
            setNotice("");
            setModalOpen(true);
          }}
        >
          <Plus size={16} /> Add vendor
        </button>
      </div>
      <Vendors data={data} onPage={load} />
      {modalOpen && (
        <VendorForm
          categoryOptions={categoryOptions}
          onSubmit={createVendor}
          onCancel={() => setModalOpen(false)}
        />
      )}
    </>
  );
}

function EmployeeDashboardContent() {
  const [data, setData] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const request = async (path, options = {}) => {
    const response = await fetch(`${API_URL}${path}`, {
      cache: "no-store",
      ...options,
      headers: {
        "Content-Type": "application/json",
        "x-admin-key": "omni-dev-key",
        ...(options.headers || {}),
      },
    });
    return response.status === 204 ? null : parseResponse(response);
  };
  const load = () => {
    request("/employees?page=1&limit=50")
      .then(setData)
      .catch((error) => setNotice(error.message));
  };
  useEffect(() => {
    load();
  }, []);
  const createEmployee = async (employee) => {
    const result = await request("/employees", {
      method: "POST",
      body: JSON.stringify(employee),
    });
    setModalOpen(false);
    setNotice("Employee added successfully.");
    setData((current) =>
      current
        ? {
          ...current,
          data: [result, ...(current.data || [])],
          total: (current.total || 0) + 1,
        }
        : current,
    );
    load();
  };
  return (
    <>
      {notice && <div className="dashboard-notice">{notice}</div>}
      <div className="dashboard-actions-row">
        <button
          className="button primary"
          onClick={() => {
            setNotice("");
            setModalOpen(true);
          }}
        >
          <Plus size={16} /> Add employee
        </button>
      </div>
      <Employees data={data} onPage={load} />
      {modalOpen && (
        <EmployeeForm
          onSubmit={createEmployee}
          onCancel={() => setModalOpen(false)}
        />
      )}
    </>
  );
}

function NotificationsDashboard({ notifications, onOpen }) {
  return (
    <section className="data-panel notifications-dashboard">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">WORKSPACE ACTIVITY</div>
          <h2>Notifications</h2>
        </div>
        <span className="notifications-total">{notifications.length} recent</span>
      </div>
      {notifications.length ? notifications.map((notification) => (
        <button
          type="button"
          className={`notification-row${notification.unread ? " unread" : ""}`}
          key={notification.id}
          onClick={() => onOpen(notification)}
        >
          <span className={`notification-type notification-type-${notification.type.toLowerCase().replace(/\s+/g, "-")}`}>
            {notification.type === "Message" ? <Users size={15} /> : notification.type === "Inquiry" ? <MessageCircle size={15} /> : <Mail size={15} />}
          </span>
          <span className="notification-copy">
            <strong>{notification.type} from {notification.customerName}</strong>
            <span>{notification.details}</span>
          </span>
          <time>{formatMarketplaceDateTime(notification.createdAt)}</time>
        </button>
      )) : <div className="empty">No notifications yet.</div>}
    </section>
  );
}

function DashboardWorkspace({ initialSection = "Overview" }) {
  const [section, setSection] = useState(initialSection);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [data, setData] = useState(null);
  const [categoryOptions, setCategoryOptions] = useState([]);
  const [categoryForm, setCategoryForm] = useState({});
  const [categorySubmitting, setCategorySubmitting] = useState(false);
  const [messageUnreadTotal, setMessageUnreadTotal] = useState(0);
  const [inquiryUnreadTotal, setInquiryUnreadTotal] = useState(0);
  const [contactRequestUnreadTotal, setContactRequestUnreadTotal] = useState(0);
  const [notifications, setNotifications] = useState([]);
  const notificationIdsRef = useRef(new Set());
  const notificationAudioRef = useRef(null);
  const audioUnlockedRef = useRef(false);
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [vendorModalOpen, setVendorModalOpen] = useState(false);
  const [productView, setProductView] = useState(null);
  const [productDelete, setProductDelete] = useState(null);
  const [productDeleting, setProductDeleting] = useState(false);
  const [categoryToDelete, setCategoryToDelete] = useState(null);
  const [categoryDeleting, setCategoryDeleting] = useState(false);
  const [categoryDeleteError, setCategoryDeleteError] = useState("");
  const [notice, setNotice] = useState("");
  const loadRequestRef = useRef(0);
  const loadRef = useRef(null);
  const sectionDataRef = useRef({});
  const sectionRef = useRef(section);
  const request = async (path, options = {}) => {
    const response = await fetch(`${API_URL}${path}`, {
      cache: "no-store",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
        ...(options.headers || {}),
      },
    });
    return response.status === 204 ? null : parseResponse(response);
  };
  const load = async (target = section, page = data?.page || 1) => {
    const requestId = ++loadRequestRef.current;
    try {
      let nextData;
      if (target === "Overview")
        nextData = await request("/dashboard/overview");
      if (target === "Products") nextData = await request("/products?limit=50");
      if (target === "Categories")
        nextData = await request(`/categories?page=${page}&limit=10`);
      if (target === "Vendors")
        nextData = await request(`/vendors?page=${page}&limit=50`);
      if (target === "Inquiries") nextData = await request(`/inquiries?page=${page}&limit=20`);
      if (target === "Contact Requests") nextData = await request(`/contact-requests?page=${page}&limit=20`);
      sectionDataRef.current[target] = nextData;
      if (requestId === loadRequestRef.current && target === sectionRef.current) {
        setData(nextData);
        if (target === "Overview") {
          window.dispatchEvent(
            new CustomEvent("omni-message-total-update", {
              detail: { total: Number(nextData?.unreadMessages || 0) },
            }),
          );
        }
      }
    } catch (error) {
      if (requestId === loadRequestRef.current) setNotice(error.message);
    }
  };
  loadRef.current = load;
  useEffect(() => {
    sectionRef.current = section;
  }, [section]);
  useEffect(() => {
    const cachedData = sectionDataRef.current[section];
    if (cachedData && section !== "Categories") {
      setData(cachedData);
      return;
    }
    load();
  }, [section]);
  useEffect(() => {
    const syncRoute = () => {
      setSection(dashboardSectionFromPath(window.location.pathname));
      setData(null);
    };
    window.addEventListener("popstate", syncRoute);
    return () => window.removeEventListener("popstate", syncRoute);
  }, []);
  useEffect(() => {
    getJson("/categories?page=1&limit=100", 30000)
      .then((result) => setCategoryOptions(result.data || []))
      .catch(() => { });
  }, []);
  useEffect(() => {
    const handleUnreadTotal = (event) => setMessageUnreadTotal(Number(event.detail?.total || 0));
    window.addEventListener("omni-message-total-update", handleUnreadTotal);
    return () => window.removeEventListener("omni-message-total-update", handleUnreadTotal);
  }, []);
  useEffect(() => {
    const refreshMessageBadge = () => {
      request("/dashboard/message-badge")
        .then((result) => {
          window.dispatchEvent(new CustomEvent("omni-message-total-update", {
            detail: { total: Number(result?.unreadMessages || 0) },
          }));
        })
        .catch(() => { });
    };
    refreshMessageBadge();
    const pollingTimer = setInterval(refreshMessageBadge, 2500);
    return () => clearInterval(pollingTimer);
  }, []);
  useEffect(() => {
    const unlockAudio = () => {
      audioUnlockedRef.current = true;
      if (!notificationAudioRef.current) notificationAudioRef.current = new Audio("/Ring.wav");
      notificationAudioRef.current.load();
    };
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    window.addEventListener("keydown", unlockAudio, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
    };
  }, []);
  useEffect(() => {
    const socket = io(API_ORIGIN, {
      auth: { token: authToken() },
      transports: ["websocket", "polling"],
    });
    const reconcile = () => {
      request("/dashboard/badges")
        .then((result) => {
          setInquiryUnreadTotal(Number(result?.newInquiries || 0));
          setContactRequestUnreadTotal(Number(result?.newContactRequests || 0));
          window.dispatchEvent(new CustomEvent("omni-message-total-update", {
            detail: { total: Number(result?.unreadMessages || 0) },
          }));
          if (["Overview", "Inquiries", "Contact Requests"].includes(sectionRef.current)) {
            loadRef.current?.(sectionRef.current);
          }
        })
        .catch(() => { });
    };
    const playNotificationSound = () => {
      if (!audioUnlockedRef.current) return;
      const audio = notificationAudioRef.current || new Audio("/Ring.wav");
      notificationAudioRef.current = audio;
      audio.currentTime = 0;
      audio.play().catch(() => { });
    };
    const handleRealtimeChange = (payload) => {
      window.dispatchEvent(new CustomEvent("omni-message-change", { detail: payload }));
      if (payload?.notification?.id && !notificationIdsRef.current.has(payload.notification.id)) {
        notificationIdsRef.current.add(payload.notification.id);
        setNotifications((current) => [payload.notification, ...current.filter((item) => item.id !== payload.notification.id)]);
        playNotificationSound();
      }
      reconcile();
    };
    reconcile();
    socket.on("message.changed", handleRealtimeChange);
    socket.on("inquiry.changed", handleRealtimeChange);
    socket.on("contact.changed", handleRealtimeChange);
    socket.on("connect", reconcile);
    return () => {
      socket.off("message.changed", handleRealtimeChange);
      socket.off("inquiry.changed", handleRealtimeChange);
      socket.off("contact.changed", handleRealtimeChange);
      socket.off("connect", reconcile);
      socket.disconnect();
    };
  }, []);
  useEffect(() => {
    if (section !== "Notifications") return;
    request("/dashboard/notifications")
      .then((result) => {
        const next = result?.data || [];
        next.forEach((item) => notificationIdsRef.current.add(item.id));
        setNotifications(next);
      })
      .catch(() => { });
  }, [section]);
  useEffect(() => {
    const view = (event) => setProductView(event.detail);
    const remove = (event) => setProductDelete(event.detail);
    const edit = (event) => {
      setCategoryForm({
        __productEdit: true,
        product: event.detail,
        categoryOptions,
      });
      setCategoryModalOpen(true);
    };
    window.addEventListener("product-view", view);
    window.addEventListener("product-delete", remove);
    window.addEventListener("product-edit", edit);
    return () => {
      window.removeEventListener("product-view", view);
      window.removeEventListener("product-delete", remove);
      window.removeEventListener("product-edit", edit);
    };
  }, [categoryOptions]);
  const choose = (target) => {
    setMobileNavOpen(false);
    if (target === "Add Product") {
      setCategoryForm({ __productModal: true, categoryOptions });
      setCategoryModalOpen(true);
      return;
    }
    if (target === "Add Vendor") {
      setNotice("");
      setVendorModalOpen(true);
      return;
    }
    const path = dashboardPath(target);
    if (window.location.pathname !== path)
      window.history.pushState({}, "", path);
    setSection(target);
    setData(sectionDataRef.current[target] || null);
  };
  const openNotification = async (notification) => {
    if (notification.unread && ["Inquiry", "Contact Request"].includes(notification.type)) {
      await request("/dashboard/notifications/read", {
        method: "POST",
        body: JSON.stringify({ type: notification.type, id: notification.id.split(":").slice(1).join(":") }),
      }).catch(() => { });
      setNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, unread: false } : item));
    }
    navigateTo(notification.target);
  };
  const createProduct = async ({
    event,
    images,
    video,
    tiers,
    productId,
    existingImages = [],
    existingVideo = "",
  }) => {
    event.preventDefault();
    const formData = new FormData();
    formData.append("title", event.currentTarget.title.value.trim());
    formData.append("category", event.currentTarget.category.value);
    formData.append(
      "shortDescription",
      event.currentTarget.shortDescription.value.trim(),
    );
    formData.append("tiers", JSON.stringify(tiers));
    formData.append("status", "Published");
    formData.append("existingImages", JSON.stringify(existingImages));
    formData.append("existingVideo", existingVideo);
    images.forEach((image) => formData.append("images", image));
    if (video) formData.append("video", video);
    try {
      const response = await fetch(
        `${API_URL}/products${productId ? `/${productId}` : "/upload"}`,
        {
          method: productId ? "PUT" : "POST",
          headers: { "x-admin-key": "omni-dev-key" },
          body: formData,
        },
      );
      await parseResponse(response);
      invalidateClientCache("/products");
      setCategoryForm({});
      setCategoryModalOpen(false);
      setNotice(
        productId
          ? "Product updated."
          : "Product added and published to the marketplace.",
      );
      notifyCatalogChange();
      load("Products");
    } catch (error) {
      console.error("Product save failed", {
        status: error.status,
        message: error.message,
        details: error.details,
      });
      throw error;
    }
  };
  const saveCategory = async (payload) => {
    if (payload?.event) return createProduct(payload);
    const event = payload;
    event.preventDefault();
    setCategorySubmitting(true);
    const formData = new FormData(event.currentTarget);
    const editing = Boolean(categoryForm._id);
    try {
      const response = await fetch(
        `${API_URL}/categories${editing ? `/${categoryForm._id}` : "/upload"}`,
        {
          method: editing ? "PUT" : "POST",
          headers: { "x-admin-key": "omni-dev-key" },
          body: formData,
        },
      );
      const result = await parseResponse(response);
      invalidateClientCache("/categories");
      invalidateClientCache("/products");
      setCategoryOptions((current) =>
        editing
          ? current.map((item) =>
            item._id === result._id ? { ...item, ...result } : item,
          )
          : [result, ...current],
      );
      setCategoryForm({});
      setCategoryModalOpen(false);
      setNotice(
        editing ? "Category updated." : "Category added to the marketplace.",
      );
      notifyCatalogChange();
      load("Categories", editing ? data?.page || 1 : 1);
    } catch (error) {
      console.error("Category save failed", {
        status: error.status,
        message: error.message,
        details: error.details,
      });
      setNotice(error.message);
    } finally {
      setCategorySubmitting(false);
    }
  };
  const openCategoryForm = (category = {}) => {
    setCategoryForm(
      category._id ? { ...category } : { name: "", description: "" },
    );
    setNotice("");
    setCategoryModalOpen(true);
  };
  const createVendor = async (vendor) => {
    try {
      const result = await request("/vendors", {
        method: "POST",
        body: JSON.stringify(vendor),
      });
      setVendorModalOpen(false);
      setNotice("Vendor added successfully.");
      setData((current) =>
        current
          ? {
            ...current,
            data: [result, ...(current.data || [])],
            total: (current.total || 0) + 1,
          }
          : current,
      );
      load("Vendors", 1);
    } catch (error) {
      throw error;
    }
  };
  const deleteCategory = (category) => {
    setCategoryDeleteError("");
    setCategoryToDelete(category);
  };
  const confirmDeleteCategory = async () => {
    if (!categoryToDelete || categoryToDelete.productCount) return;
    setCategoryDeleting(true);
    setCategoryDeleteError("");
    try {
      const response = await fetch(
        `${API_URL}/categories/${categoryToDelete._id}`,
        { method: "DELETE", headers: { "x-admin-key": "omni-dev-key" } },
      );
      await parseResponse(response);
      invalidateClientCache("/categories");
      invalidateClientCache("/products");
      setCategoryOptions((current) =>
        current.filter((item) => item._id !== categoryToDelete._id),
      );
      if (selectedCategory === categoryToDelete.name) setSelectedCategory("");
      setCategoryToDelete(null);
      setNotice("Category deleted.");
      notifyCatalogChange();
      load("Categories", data?.page || 1);
    } catch (error) {
      console.error("Category delete failed", {
        status: error.status,
        message: error.message,
        details: error.details,
      });
      setCategoryDeleteError(error.message);
    } finally {
      setCategoryDeleting(false);
    }
  };
  const confirmDeleteProduct = async () => {
    if (!productDelete) return;
    setProductDeleting(true);
    try {
      await request(`/products/${productDelete._id}`, { method: "DELETE" });
      setProductDelete(null);
      setNotice("Product deleted.");
      load("Products");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setProductDeleting(false);
    }
  };
  const deactivate = () => {
    load("Products");
  };
  const nav = [
    { name: "Overview", icon: LayoutDashboard },
    { name: "Products", icon: Package },
    { name: "Categories", icon: Tag },
    { name: "Customers", icon: Users },
    { name: "Vendors", icon: Users },
    { name: "Employees", icon: Users },
    { name: "Inquiries", icon: MessageCircle },
    { name: "Contact Requests", icon: Mail },
    { name: "Messages", icon: Users },
    // { name: "Profile", icon: Users },
    { name: "Settings", icon: Settings },
  ];
  useEffect(() => {
    document
      .querySelectorAll(".dashboard-sidebar .sidebar-link")
      .forEach((link) => {
        const name = link.dataset.section;
        link.classList.toggle("active", name === section);
      });
  }, [section]);
  useEffect(() => {
    const isMessagesSection = section === "Messages";
    document.body.classList.toggle("messages-scroll-lock", isMessagesSection);
    return () => document.body.classList.remove("messages-scroll-lock");
  }, [section]);
  const overviewGreeting = useCurrentGreeting(storedUser().fullName || "User");
  return (
    <>
      <div
        className={
          section === "Messages"
            ? "dashboard-app messages-mode"
            : "dashboard-app"
        }
      >
        {mobileNavOpen && (
          <button
            type="button"
            className="dashboard-mobile-nav-backdrop"
            aria-label="Close dashboard navigation"
            onClick={() => setMobileNavOpen(false)}
          />
        )}
        <aside className={`dashboard-sidebar${mobileNavOpen ? " mobile-nav-open" : ""}`}>
          <a className="brand sidebar-brand" href="/">
            Vendor <span>Woo</span>
          </a>
          <div className="sidebar-label">MAIN</div>
          {nav.slice(0, 5).map(({ name, icon: Icon }) => (
            <button
              key={name}
              className={
                section === name ? "sidebar-link active" : "sidebar-link"
              }
              data-section={name}
              onClick={() => choose(name)}
            >
              <Icon size={17} />
              {name}
              {name === "Messages" && messageUnreadTotal > 0 ? <b>{messageUnreadTotal}</b> : null}
              {name === "Inquiries" && inquiryUnreadTotal > 0 ? <b>{inquiryUnreadTotal}</b> : null}
              {name === "Contact Requests" && contactRequestUnreadTotal > 0 ? <b>{contactRequestUnreadTotal}</b> : null}
            </button>
          ))}
          <div className="sidebar-label">MANAGEMENT</div>
          {nav.slice(5).map(({ name, icon: Icon }) => (
            <button
              key={name}
              className={
                section === name ? "sidebar-link active" : "sidebar-link"
              }
              data-section={name}
              onClick={() => choose(name)}
            >
              <Icon size={17} />
              {name}
              {name === "Messages" && messageUnreadTotal > 0 ? <b>{messageUnreadTotal}</b> : null}
              {name === "Inquiries" && inquiryUnreadTotal > 0 ? <b>{inquiryUnreadTotal}</b> : null}
              {name === "Contact Requests" && contactRequestUnreadTotal > 0 ? <b>{contactRequestUnreadTotal}</b> : null}
            </button>
          ))}
          <a className="sidebar-back" href="/">
            &lt;-- Back to marketplace
          </a>
        </aside>
        <div className="dashboard-main">
          <DashboardTopbar
            title={section}
            notificationCount={messageUnreadTotal + inquiryUnreadTotal + contactRequestUnreadTotal}
            onNotifications={() => choose("Notifications")}
            onMenuToggle={() => setMobileNavOpen((open) => !open)}
            mobileNavOpen={mobileNavOpen}
          />
          <main className="dashboard-content">
            {section !== "Messages" && section !== "Customers" && section !== "Vendors" && section !== "Employees" && section !== "Settings" && (
              <div className="dashboard-heading">
                <div>
                  <div className="eyebrow">VENDOR WOO OPERATIONS</div>
                  {section !== "Products" && section !== "Categories" && section !== "Inquiries" && section !== "Contact Requests" && (
                    <h1>
                      {section === "Overview"
                        ? overviewGreeting
                        : section}
                    </h1>
                  )}
                  {section !== "Overview" && section !== "Products" && section !== "Categories" && section !== "Inquiries" && section !== "Contact Requests" && (
                    <p>
                      {`Manage your ${section.toLowerCase()} from one workspace.`}
                    </p>
                  )}
                </div>
                {section === "Products" && (
                  <button
                    className="button primary"
                    onClick={() => choose("Add Product")}
                  >
                    <Plus size={16} /> Add product
                  </button>
                )}
                {section === "Categories" && (
                  <button
                    className="button primary"
                    onClick={() => openCategoryForm()}
                  >
                    <Plus size={16} /> Add category
                  </button>
                )}
              </div>
            )}
            {notice && <div className="dashboard-notice">{notice}</div>}
            {section === "Overview" && (
              <Overview data={data} onSection={choose} />
            )}
            {section === "Products" && (
              <Products
                data={data}
                categoryOptions={categoryOptions}
                onDeactivate={deactivate}
              />
            )}
            {section === "Categories" && (
              <Categories
                data={data}
                onEdit={openCategoryForm}
                onDelete={deleteCategory}
                onPage={(page) => load("Categories", page)}
              />
            )}
            {section === "Customers" && <CustomerDashboardContent />}
            {section === "Vendors" && <VendorDashboardContent />}
            {section === "Employees" && <EmployeeDashboardContent />}
            {section === "Inquiries" && (
              <Inquiries
                data={data}
                request={request}
                reload={() => load("Inquiries")}
                onPage={(page) => load("Inquiries", page)}
              />
            )}
            {section === "Contact Requests" && (
              <ContactRequests
                data={data}
                request={request}
                onPage={(page) => load("Contact Requests", page)}
                onUpdated={(updated) => setData((current) => current ? { ...current, data: current.data.map((item) => item._id === updated._id ? updated : item) } : current)}
              />
            )}
            {section === "Messages" && <MessagesWorkspace />}
            {section === "Notifications" && <NotificationsDashboard notifications={notifications} onOpen={openNotification} />}
            {section === "Profile" && <EmptyWorkspace section={section} />}
            {section === "Settings" && <SettingsWorkspace />}
          </main>
        </div>
      </div>
      {categoryModalOpen && (
        <CategoryForm
          category={categoryForm}
          setCategory={setCategoryForm}
          onSubmit={saveCategory}
          onCancel={() => setCategoryModalOpen(false)}
          submitting={categorySubmitting}
        />
      )}
      {categoryToDelete && (
        <DeleteCategoryModal
          category={categoryToDelete}
          error={categoryDeleteError}
          deleting={categoryDeleting}
          onCancel={() => !categoryDeleting && setCategoryToDelete(null)}
          onConfirm={confirmDeleteCategory}
        />
      )}
    </>
  );
}

function Overview({ data, onSection }) {
  if (!data)
    return <div className="loading-region"><Loader /></div>;
  if (
    !Array.isArray(data.recentProducts) ||
    !Array.isArray(data.recentInquiries)
  )
    return (
      <div className="dashboard-notice">
        Unable to load the marketplace overview. Please try again.
      </div>
    );
  const kpis = [
    ["Total products", data.totalProducts, Package, "All catalog records"],
    ["Categories", data.totalCategories, Tag, "Active collections"],
    ["New inquiries", data.newInquiries, MessageCircle, "Awaiting response"],
    ["Unread messages", data.unreadMessages, Users, "Across conversations"],
    [
      "Pending Contact Requests",
      Number(data.pendingContactRequests || 0),
      ClockIcon,
      Number(data.pendingContactRequests || 0) > 0
        ? "Awaiting response"
        : "All contact requests have been responded to.",
    ],
    ["Confirmed Orders", Number(data.confirmedOrders || 0), Check, "Orders confirmed from inquiries"],
  ];
  return (
    <>
      <div className="kpi-grid">
        {kpis.map(([label, value, Icon, detail]) => (
          <div className={`kpi-card kpi-${label.toLowerCase().replace(/\s+/g, "-")}`} key={label}>
            <div className="kpi-accent" />
            <span className="kpi-icon">
              <Icon size={17} />
            </span>
            <strong>{value}</strong>
            <span>{label}</span>
            <small>{detail}</small>
          </div>
        ))}
      </div>
      <div className="dashboard-columns">
        <section className="data-panel">
          <div className="panel-heading">
            <h2>Recently added products</h2>
            <button onClick={() => onSection("Products")}>
              View all <ArrowRight size={14} />
            </button>
          </div>
          {data.recentProducts.map((product) => (
            <div className="summary-row" key={product._id}>
              <img src={mediaUrl(product.image || "/1.jpeg")} alt="" />
              <div>
                <strong>{product.name}</strong>
                <small>
                  {product.category} | MOQ {product.moq}
                </small>
              </div>
              <span className={`status ${product.status.toLowerCase()}`}>
                {product.status}
              </span>
            </div>
          ))}
        </section>
        <section className="data-panel">
          <div className="panel-heading">
            <h2>Recent inquiries</h2>
            <button onClick={() => onSection("Inquiries")}>
              View all <ArrowRight size={14} />
            </button>
          </div>
          {data.recentInquiries.map((inquiry) => (
            <div className="inquiry-row" key={inquiry._id}>
              <div>
                <strong>{inquiry.buyer}</strong>
                <small>
                  {inquiry.product} | {inquiry.quantity}
                </small>
              </div>
              <span
                className={`status ${inquiry.status.toLowerCase().replace(" ", "-")}`}
              >
                {inquiry.status}
              </span>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
const ClockIcon = ({ size }) => <span style={{ fontSize: size }}>o</span>;
function Products({ data, onDeactivate, categoryOptions = [] }) {
  const [viewProduct, setViewProduct] = useState(null);
  const [deleteProduct, setDeleteProduct] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
  useEffect(() => {
    if (
      selectedCategory &&
      !categoryOptions.some((category) => category.name === selectedCategory)
    ) setSelectedCategory("");
  }, [categoryOptions, selectedCategory]);
  const filteredProducts = (data?.data || []).filter((product) => {
    const matchesSearch = !searchTerm.trim()
      || (product.title || product.name || "")
        .toLowerCase()
        .includes(searchTerm.trim().toLowerCase());
    const matchesCategory = !selectedCategory
      || String(product.category || "")
        .toLowerCase() === String(selectedCategory).toLowerCase();
    return matchesSearch && matchesCategory;
  });
  const remove = async () => {
    if (!deleteProduct) return;
    try {
      const response = await fetch(`${API_URL}/products/${deleteProduct._id}`, {
        method: "DELETE",
        headers: { "x-admin-key": "omni-dev-key" },
      });
      if (!response.ok) throw new Error("Unable to delete product");
      setDeleteProduct(null);
      onDeactivate();
    } catch (error) {
      setDeleteProduct({ ...deleteProduct, error: error.message });
    } finally {
      setDeleting(false);
    }
  };
  if (!data) return <div className="loading-region"><Loader /></div>;
  return (
    <>
      {viewProduct && (
        <div
          className="contact-overlay"
          role="dialog"
          aria-modal="true"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setViewProduct(null);
          }}
        >
          <div className="contact-modal product-view-modal">
            <div className="modal-heading">
              <div>
                <div className="eyebrow">PRODUCT DETAILS</div>
                <h2>{viewProduct.title || viewProduct.name}</h2>
              </div>
              <button
                className="modal-close"
                onClick={() => setViewProduct(null)}
                aria-label="Close product details"
              >
                <X size={18} />
              </button>
            </div>
            <div className="product-view-images">
              {(viewProduct.images?.length
                ? viewProduct.images
                : [viewProduct.image]
              ).map((image) => (
                <img
                  key={image}
                  src={mediaUrl(image)}
                  alt={viewProduct.title || viewProduct.name}
                />
              ))}
            </div>
            <p>{viewProduct.shortDescription || viewProduct.description}</p>
            <div className="product-view-fields">
              <strong>Category: {viewProduct.category}</strong>
              {(viewProduct.priceTiers || viewProduct.tiers || []).map(
                (tier, index) => (
                  <span key={index}>
                    Tier {index + 1}: {tier.price} | {tier.moqMin}-
                    {tier.moqMax} units
                  </span>
                ),
              )}
              {viewProduct.video && (
                <a
                  href={mediaUrl(viewProduct.video)}
                  target="_blank"
                  rel="noreferrer"
                >
                  View product video
                </a>
              )}
            </div>
            <button
              className="button quiet"
              onClick={() => setViewProduct(null)}
            >
              Close
            </button>
          </div>
        </div>
      )}
      {deleteProduct && (
        <div
          className="contact-overlay"
          role="dialog"
          aria-modal="true"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deleting)
              setDeleteProduct(null);
          }}
        >
          <div className="contact-modal delete-category-modal">
            <div className="modal-heading">
              <div>
                <div className="eyebrow">PRODUCT MANAGEMENT</div>
                <h2>Delete product?</h2>
              </div>
              <button
                className="modal-close"
                onClick={() => !deleting && setDeleteProduct(null)}
                aria-label="Close delete confirmation"
              >
                <X size={18} />
              </button>
            </div>
            <p className="delete-category-copy">
              Are you sure you want to permanently delete this product?
            </p>
            <div className="delete-category-name">
              {deleteProduct.title || deleteProduct.name}
            </div>
            {deleteProduct.error && (
              <div className="form-error">{deleteProduct.error}</div>
            )}
            <div className="modal-actions">
              <button
                className="button quiet"
                onClick={() => setDeleteProduct(null)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="button danger"
                onClick={remove}
                disabled={deleting}
              >
                {deleting ? <Loader /> : <>Delete <Trash2 size={15} /></>}
              </button>
            </div>
          </div>
        </div>
      )}
      <section className="data-panel table-panel product-dashboard-panel">
        <div className="panel-tools product-panel-tools">
          <label className="search-field product-search-field">
            <Search size={16} />
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search products"
              aria-label="Search products by title"
            />
          </label>
          <label className="product-filter-field">
            <select
              value={selectedCategory}
              onChange={(event) => setSelectedCategory(event.target.value)}
              aria-label="Filter products by category"
            >
              <option value="">Select by Categories</option>
              {categoryOptions.map((category) => (
                <option key={category._id || category.name} value={category.name}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Image</th>
                <th>Product Title</th>
                <th>Category</th>
                <th>Price</th>
                <th>MOQ</th>
                <th>View</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredProducts.map((product) => (
                <tr key={product._id}>
                  <td>
                    <div className="table-product">
                      <img src={mediaUrl(product.image) || "/1.jpeg"} alt="" />
                    </div>
                  </td>
                  <td>
                    <strong>{product.title || product.name}</strong>
                  </td>
                  <td>{product.category}</td>
                  <td>{product.price}</td>
                  <td>{product.moq}</td>
                  <td>
                    <button
                      className="table-action"
                      onClick={() => setViewProduct(product)}
                    >
                      View
                    </button>
                  </td>
                  <td>
                    <div className="product-actions">
                      <button
                        className="table-action"
                        onClick={() =>
                          window.dispatchEvent(
                            new CustomEvent("product-edit", {
                              detail: product,
                            }),
                          )
                        }
                      >
                        Edit
                      </button>
                      <button
                        className="table-action product-delete"
                        onClick={() => setDeleteProduct(product)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
function Categories({ data, onEdit, onDelete, onPage }) {
  const [searchTerm, setSearchTerm] = useState("");
  const [searchPage, setSearchPage] = useState(1);
  const normalizedSearch = searchTerm.trim().toLowerCase();
  useEffect(() => {
    setSearchPage(1);
  }, [searchTerm]);
  const pageSize = data?.limit || 10;
  const filteredCategories = !normalizedSearch
    ? (data?.data || [])
    : (data?.data || []).filter((category) =>
      String(category.name || "").toLowerCase().includes(normalizedSearch),
    );
  const totalPages = Math.max(1, Math.ceil(filteredCategories.length / pageSize));
  const currentPage = normalizedSearch ? Math.min(searchPage, totalPages) : data?.page || 1;
  const visibleRows = normalizedSearch
    ? filteredCategories.slice((currentPage - 1) * pageSize, currentPage * pageSize)
    : data?.data || [];
  const showPagination = normalizedSearch ? totalPages > 1 : data?.pages > 1;
  const handlePageChange = (nextPage) => {
    if (normalizedSearch) {
      setSearchPage(Math.max(1, Math.min(nextPage, totalPages)));
      return;
    }
    onPage(nextPage);
  };
  if (!data) return <div className="loading-region"><Loader /></div>;
  return (
    <section className="data-panel table-panel category-table">
      <div className="panel-tools product-panel-tools">
        <label className="search-field product-search-field">
          <Search size={16} />
          <input
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search categories"
            aria-label="Search categories by name"
          />
        </label>
      </div>
      {!normalizedSearch && !data.data?.length ? (
        <div className="empty-workspace">
          <span>
            <Tag size={22} />
          </span>
          <h2>No categories yet</h2>
          <p>Add your first marketplace category to get started.</p>
        </div>
      ) : normalizedSearch && !filteredCategories.length ? (
        <div className="empty-workspace">
          <span>
            <Search size={22} />
          </span>
          <h2>No categories found</h2>
          <p>Try a different category name to find what you need.</p>
        </div>
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Image</th>
                  <th>Category name</th>
                  <th>Number of products</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((category) => (
                  <tr key={category._id}>
                    <td>
                      <img
                        className="category-thumbnail"
                        src={mediaUrl(category.image)}
                        alt=""
                      />
                    </td>
                    <td>
                      <strong>{category.name}</strong>
                      <small className="category-slug">/{category.slug}</small>
                    </td>
                    <td>
                      {category.productCount}{" "}
                      {category.productCount === 1 ? "Product" : "Products"}
                    </td>
                    <td>
                      <div className="category-actions">
                        <button
                          className="table-action category-edit"
                          onClick={() => onEdit(category)}
                        >
                          <Edit3 size={14} /> Edit
                        </button>
                        <button
                          className="table-action category-delete"
                          onClick={() => onDelete(category)}
                        >
                          <Trash2 size={14} /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {showPagination && (
            <div className="pagination">
              <button
                disabled={currentPage <= 1}
                onClick={() => handlePageChange(currentPage - 1)}
                aria-label="Previous page"
              >
                <ChevronLeft size={16} />
              </button>
              <span>
                Page {currentPage} of {normalizedSearch ? totalPages : data.pages}
              </span>
              <button
                disabled={currentPage >= (normalizedSearch ? totalPages : data.pages)}
                onClick={() => handlePageChange(currentPage + 1)}
                aria-label="Next page"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
function VendorViewModal({ vendor, onClose }) {
  return (
    <div
      className="contact-overlay"
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="contact-modal vendor-view-modal">
        <div className="modal-heading">
          <div>
            <div className="eyebrow">VENDOR DETAILS</div>
            <h2>{vendor.registeredBusinessName}</h2>
          </div>
          <button
            className="modal-close"
            onClick={onClose}
            aria-label="Close vendor details"
          >
            <X size={18} />
          </button>
        </div>
        <div className="vendor-detail-fields">
          <span>
            <strong>Owner Name</strong>
            {vendor.ownerName}
          </span>
          <span>
            <strong>Registered Business Name</strong>
            {vendor.registeredBusinessName}
          </span>
          <span>
            <strong>Registered Business Address</strong>
            {vendor.registeredBusinessAddress}
          </span>
          <span>
            <strong>Registered Phone Number</strong>
            {vendor.registeredPhoneNumber}
          </span>
          <span>
            <strong>Registered Email Address</strong>
            {vendor.registeredEmailAddress}
          </span>
          <span>
            <strong>Category</strong>
            {vendor.category}
          </span>
        </div>
        <button className="button quiet" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
function DeleteVendorModal({ vendor, deleting, error, onCancel, onConfirm }) {
  return (
    <div
      className="contact-overlay category-overlay"
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !deleting) onCancel();
      }}
    >
      <div className="contact-modal delete-category-modal">
        <div className="modal-heading">
          <div>
            <div className="eyebrow">VENDOR MANAGEMENT</div>
            <h2>Delete vendor?</h2>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onCancel}
            disabled={deleting}
            aria-label="Close delete confirmation"
          >
            <X size={18} />
          </button>
        </div>
        <p className="delete-category-copy">
          Are you sure you want to delete this vendor? This action cannot be
          undone.
        </p>
        <div className="delete-category-name">
          {vendor.registeredBusinessName}
        </div>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button quiet"
            onClick={onCancel}
            disabled={deleting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button danger"
            onClick={onConfirm}
            disabled={deleting}
          >
            {deleting ? <Loader /> : <>Delete <Trash2 size={15} /></>}
          </button>
        </div>
      </div>
    </div>
  );
}
function Vendors({ data, onPage }) {
  const [viewVendor, setViewVendor] = useState(null);
  const [editVendor, setEditVendor] = useState(null);
  const [deleteVendor, setDeleteVendor] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [searchPage, setSearchPage] = useState(1);
  const normalizedSearch = searchTerm.trim().toLowerCase();
  useEffect(() => {
    setSearchPage(1);
  }, [searchTerm]);
  const pageSize = data?.limit || 50;
  const filteredVendors = !normalizedSearch
    ? (data?.data || [])
    : (data?.data || []).filter((vendor) => {
      const haystack = [
        vendor.ownerName,
        vendor.registeredBusinessName,
        vendor.category,
      ].join(" ").toLowerCase();
      return haystack.includes(normalizedSearch);
    });
  const totalPages = Math.max(1, Math.ceil(filteredVendors.length / pageSize));
  const currentPage = normalizedSearch ? Math.min(searchPage, totalPages) : data?.page || 1;
  const visibleRows = normalizedSearch
    ? filteredVendors.slice((currentPage - 1) * pageSize, currentPage * pageSize)
    : data?.data || [];
  const showPagination = normalizedSearch ? totalPages > 1 : data?.pages > 1;
  const handlePageChange = (nextPage) => {
    if (normalizedSearch) {
      setSearchPage(Math.max(1, Math.min(nextPage, totalPages)));
      return;
    }
    onPage(nextPage);
  };
  const request = async (path, options = {}) => {
    const response = await fetch(`${API_URL}${path}`, {
      cache: "no-store",
      ...options,
      headers: {
        "Content-Type": "application/json",
        "x-admin-key": "omni-dev-key",
        ...(options.headers || {}),
      },
    });
    return response.status === 204 ? null : parseResponse(response);
  };
  const updateVendor = async (vendor) => {
    const result = await request(`/vendors/${editVendor._id}`, {
      method: "PUT",
      body: JSON.stringify(vendor),
    });
    setEditVendor(null);
    setNotice("Vendor updated successfully.");
    onPage(result);
  };
  const confirmDelete = async () => {
    if (!deleteVendor) return;
    setDeleting(true);
    try {
      await request(`/vendors/${deleteVendor._id}`, { method: "DELETE" });
      setDeleteVendor(null);
      setNotice("Vendor deleted.");
      onPage();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setDeleting(false);
    }
  };
  if (!data) return <div className="loading-region"><Loader /></div>;
  return (
    <>
      {notice && <div className="dashboard-notice">{notice}</div>}
      <section className="data-panel table-panel vendor-table">
        <div className="panel-tools product-panel-tools">
          <label className="search-field product-search-field">
            <Search size={16} />
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search vendors"
              aria-label="Search vendors by company name"
            />
          </label>
        </div>
        {!normalizedSearch && !data.data?.length ? (
          <div className="empty-workspace">
            <span>
              <Users size={22} />
            </span>
            <h2>No vendors yet</h2>
            <p>Add your first vendor to get started.</p>
          </div>
        ) : normalizedSearch && !filteredVendors.length ? (
          <div className="empty-workspace">
            <span>
              <Search size={22} />
            </span>
            <h2>No vendors found</h2>
            <p>Try a different vendor or company name.</p>
          </div>
        ) : (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Owner name</th>
                    <th>Registered business</th>
                    <th>Phone number</th>
                    <th>Email address</th>
                    <th>Category</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((vendor) => (
                    <tr key={vendor._id}>
                      <td>
                        <strong>{vendor.ownerName}</strong>
                      </td>
                      <td>
                        {vendor.registeredBusinessName}
                        <small className="category-slug">
                          {vendor.registeredBusinessAddress}
                        </small>
                      </td>
                      <td>{vendor.registeredPhoneNumber}</td>
                      <td>{vendor.registeredEmailAddress}</td>
                      <td>{vendor.category}</td>
                      <td>
                        <div className="vendor-actions">
                          <button
                            className="table-action"
                            onClick={() => setViewVendor(vendor)}
                          >
                            View
                          </button>
                          <button
                            className="table-action category-edit"
                            onClick={() => setEditVendor(vendor)}
                          >
                            <Edit3 size={14} /> Edit
                          </button>
                          <button
                            className="table-action category-delete"
                            onClick={() => setDeleteVendor(vendor)}
                          >
                            <Trash2 size={14} /> Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {showPagination && (
              <div className="pagination">
                <button
                  disabled={currentPage <= 1}
                  onClick={() => handlePageChange(currentPage - 1)}
                  aria-label="Previous page"
                >
                  <ChevronLeft size={16} />
                </button>
                <span>
                  Page {currentPage} of {normalizedSearch ? totalPages : data.pages}
                </span>
                <button
                  disabled={currentPage >= (normalizedSearch ? totalPages : data.pages)}
                  onClick={() => handlePageChange(currentPage + 1)}
                  aria-label="Next page"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
          </>
        )}
      </section>
      {viewVendor && (
        <VendorViewModal
          vendor={viewVendor}
          onClose={() => setViewVendor(null)}
        />
      )}
      {editVendor && (
        <VendorForm
          vendor={editVendor}
          categoryOptions={[]}
          onSubmit={updateVendor}
          onCancel={() => setEditVendor(null)}
        />
      )}
      {deleteVendor && (
        <DeleteVendorModal
          vendor={deleteVendor}
          deleting={deleting}
          error={notice}
          onCancel={() => setDeleteVendor(null)}
          onConfirm={confirmDelete}
        />
      )}
    </>
  );
}
function ContactRequests({ data, request, onUpdated, onPage }) {
  const [respondingId, setRespondingId] = useState(null);
  const [error, setError] = useState("");
  const markAsResponded = async (contactRequest) => {
    if (respondingId) return;
    setRespondingId(contactRequest._id);
    setError("");
    try {
      const updated = await request(`/contact-requests/${contactRequest._id}/respond`, { method: "PUT" });
      onUpdated(updated);
    } catch (responseError) {
      setError(responseError.message);
    } finally {
      setRespondingId(null);
    }
  };
  if (!data) return <div className="loading-region"><Loader /></div>;
  return (
    <section className="data-panel inquiries-admin">
      {error && <div className="form-error" role="alert">{error}</div>}
      {data?.data?.length ? data.data.map((contactRequest) => {
        const messageLines = String(contactRequest.message || "").split(/\r?\n/).filter(Boolean);
        const isSourcingRequest = contactRequest.source === "Ricky/AI" && messageLines.some((line) => line.startsWith("Product: ")) &&
          messageLines.some((line) => line.startsWith("MOQ: ")) &&
          messageLines.some((line) => line.startsWith("Target price: "));
        return (
          <div className={`inquiry-admin-row ${contactRequest.status !== "New" ? "responded" : ""}`} key={contactRequest._id}>
            <div>
              <strong className="inquiry-product-title">{isSourcingRequest ? `Name: ${contactRequest.customerName || contactRequest.name}` : contactRequest.customerName || contactRequest.name}</strong>
              <p className="inquiry-contact">
                <span><Mail size={13} /> {contactRequest.email}</span>
                <span><Phone size={13} /> {contactRequest.phoneNumber}</span>
              </p>
              {isSourcingRequest ? (
                <div className="contact-request-sourcing-details">
                  {messageLines.map((line, index) => <p key={`${contactRequest._id}-detail-${index}`}>{line}</p>)}
                </div>
              ) : (
                <p>{contactRequest.message}</p>
              )}
              <small>{formatMarketplaceDateTime(contactRequest.createdAt || contactRequest.submittedAt)}</small>
            </div>
            <div className="inquiry-actions">
              {contactRequest.status !== "New" ? <span className="status">{contactRequest.status}</span> : (
                <button className="inquiry-respond-action" onClick={() => markAsResponded(contactRequest)} disabled={respondingId === contactRequest._id}>
                  {respondingId === contactRequest._id ? <Loader /> : <><CheckCircle2 size={14} /> Mark as Response</>}
                </button>
              )}
            </div>
          </div>
        );
      }) : <div className="empty">No contact requests yet.</div>}
      {data?.pages > 1 && (
        <div className="pagination-controls">
          <button className="button quiet" disabled={data.page <= 1} onClick={() => onPage(data.page - 1)}>Previous</button>
          <span>Page {data.page} of {data.pages}</span>
          <button className="button quiet" disabled={data.page >= data.pages} onClick={() => onPage(data.page + 1)}>Next</button>
        </div>
      )}
    </section>
  );
}

function Inquiries({ data, request, reload, onPage }) {
  const [selected, setSelected] = useState(null);
  const [modal, setModal] = useState(null);
  const [reason, setReason] = useState("");
  const [finalMoq, setFinalMoq] = useState("");
  const [finalMessage, setFinalMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const defaultOrderMessage = (inquiry, moq) => `Thank you for choosing us! 🎉\n\nWe’re happy to let you know that your order for ${inquiry.product} has been successfully confirmed.\n\n📦 Confirmed Quantity: ${moq}${/units?$/i.test(String(moq).trim()) ? "" : " units"}\n\nThank you for your trust and for choosing to work with us. Our team will now proceed with the next steps and will contact you shortly with any further order details.\n\nWe truly appreciate your business and look forward to serving you!`;
  const openDetails = (inquiry) => {
    setSelected(inquiry);
    setModal("details");
    setError("");
  };
  const openOrderConfirmation = () => {
    const moq = selected.quantity || "";
    setFinalMoq(moq);
    setFinalMessage(defaultOrderMessage(selected, moq));
    setModal("order");
  };
  const submitResponse = async (payload) => {
    if (!selected || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await request(`/inquiries/${selected._id}/respond`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      setSelected(null);
      setModal(null);
      setReason("");
      setFinalMoq("");
      setFinalMessage("");
      reload();
    } catch (error) {
      setError(error.message);
    } finally {
      setSubmitting(false);
    }
  };
  const closeModal = () => {
    if (!submitting) {
      setSelected(null);
      setModal(null);
      setError("");
    }
  };
  if (!data) return <div className="loading-region"><Loader /></div>;
  return (
    <section className="data-panel inquiries-admin">
      {data?.data?.map((inquiry) => (
        <div className={`inquiry-admin-row ${inquiry.status !== "New" ? "responded" : ""}${inquiry.productImage ? " has-product-image" : ""}`} key={inquiry._id}>
          {inquiry.productImage ? <img className="inquiry-product-image" src={mediaUrl(inquiry.productImage)} alt="" /> : null}
          <div className="inquiry-admin-copy">
            <strong className="inquiry-product-title">{inquiry.product}</strong>
            <small className="inquiry-moq">MOQ: {inquiry.quantity || "Not specified"}</small>
            <p className="inquiry-contact">
              <span><Mail size={13} /> {inquiry.email}</span>
              <span><Phone size={13} /> {inquiry.phoneNumber}</span>
            </p>
            <small>{inquiry.buyer} · {formatMarketplaceDateTime(inquiry.createdAt || inquiry.submittedAt)}</small>
          </div>
          <div className="inquiry-actions">
            {inquiry.status !== "New" && <span className="status">{inquiry.status}</span>}
            <button className="table-action" onClick={() => openDetails(inquiry)}><Eye size={14} /> Open</button>
            {inquiry.status === "New" && <button className="inquiry-respond-action" onClick={() => openDetails(inquiry)}><MessageCircle size={14} /> Response</button>}
          </div>
        </div>
      ))}
      {selected && modal === "details" && (
        <div className="contact-overlay" role="dialog" aria-modal="true" onMouseDown={(event) => event.target === event.currentTarget && closeModal()}>
          <div className="contact-modal inquiry-response-modal">
            <div className="modal-heading"><div><div className="eyebrow">INQUIRY DETAILS</div><h2>{selected.product || "Product inquiry"}</h2></div><button className="modal-close" onClick={closeModal} aria-label="Close inquiry details"><X size={18} /></button></div>
            <div className="inquiry-modal-product">
              {selected.productImage ? <img src={mediaUrl(selected.productImage)} alt={selected.product || "Product"} /> : <div className="inquiry-image-placeholder"><Image size={22} /></div>}
              <div><strong>{selected.product || "Product inquiry"}</strong><span>Requested MOQ: {selected.quantity || "Not specified"}</span></div>
            </div>
            <div className="inquiry-detail-grid"><span><strong>Customer</strong>{selected.buyer}</span><span><strong>Email</strong>{selected.email}</span><span><strong>Phone</strong>{selected.phoneNumber || "Not provided"}</span><span><strong>Submitted</strong>{formatMarketplaceDateTime(selected.createdAt || selected.submittedAt)}</span></div>
            <div className="inquiry-message-detail"><strong>Inquiry message</strong><p>{selected.message}</p></div>
            {selected.status !== "New" && (
              <div className="inquiry-response-history">
                <div className="inquiry-response-history-heading">
                  <strong>Response Details</strong>
                  <span className="status">{selected.status}</span>
                </div>
                <div className="inquiry-detail-grid">
                  {selected.status === "Order Confirmed" && (
                    <>
                      <span><strong>Final MOQ</strong>{selected.finalMoq || "Not specified"}</span>
                      <span><strong>Confirmed On</strong>{formatMarketplaceDateTime(selected.orderConfirmedAt || selected.responses?.at(-1)?.createdAt)}</span>
                      <span className="inquiry-response-full"><strong>Confirmation Message</strong>{selected.finalMessage || selected.responses?.at(-1)?.message || "No confirmation message recorded."}</span>
                    </>
                  )}
                  {selected.status === "Not Interested" && (
                    <>
                      <span className="inquiry-response-full"><strong>Reason</strong>{selected.notInterestedReason || selected.responses?.at(-1)?.message || "No reason recorded."}</span>
                      <span><strong>Responded On</strong>{formatMarketplaceDateTime(selected.responses?.at(-1)?.createdAt)}</span>
                    </>
                  )}
                  {selected.status === "Responded" && selected.responses?.length > 0 && (
                    <span className="inquiry-response-full"><strong>Response</strong>{selected.responses.at(-1).message}</span>
                  )}
                </div>
              </div>
            )}
            {error && <div className="form-error" role="alert">{error}</div>}
            {selected.status === "New" && <div className="modal-actions inquiry-main-actions"><button className="button inquiry-not-interested" onClick={() => { setReason(""); setError(""); setModal("not-interested"); }}>Customer Not Interested</button><button className="button inquiry-order-confirm" onClick={openOrderConfirmation}>Order Confirm</button></div>}
          </div>
        </div>
      )}
      {selected && modal === "not-interested" && (
        <div className="contact-overlay" role="dialog" aria-modal="true"><div className="contact-modal inquiry-small-modal"><div className="modal-heading"><div><div className="eyebrow">INQUIRY RESPONSE</div><h2>Customer Not Interested</h2><p>Record a reason for this response.</p></div><button className="modal-close" onClick={() => setModal("details")} disabled={submitting} aria-label="Close response"><X size={18} /></button></div><label className="inquiry-field-label">Reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Enter the reason" /></label>{error && <div className="form-error" role="alert">{error}</div>}<div className="modal-actions"><button className="button quiet" onClick={() => setModal("details")} disabled={submitting}>Cancel</button><button className="button inquiry-not-interested" onClick={() => submitResponse({ action: "not-interested", reason })} disabled={submitting || !reason.trim()}>{submitting ? <Loader /> : "Confirm"}</button></div></div></div>
      )}
      {selected && modal === "order" && (
        <div className="contact-overlay" role="dialog" aria-modal="true"><div className="contact-modal inquiry-response-modal"><div className="modal-heading"><div><div className="eyebrow">ORDER CONFIRMATION</div><h2>Confirm {selected.product}</h2><p>Review the final quantity and message before confirming.</p></div><button className="modal-close" onClick={() => setModal("details")} disabled={submitting} aria-label="Close order confirmation"><X size={18} /></button></div><label className="inquiry-field-label">Final MOQ<input value={finalMoq} onChange={(event) => { setFinalMoq(event.target.value); setFinalMessage(defaultOrderMessage(selected, event.target.value)); }} /></label><label className="inquiry-field-label">Message<textarea value={finalMessage} onChange={(event) => setFinalMessage(event.target.value)} /></label>{error && <div className="form-error" role="alert">{error}</div>}<div className="modal-actions inquiry-main-actions"><button className="button quiet" onClick={() => setModal("details")} disabled={submitting}>Back</button><button className="button inquiry-order-confirm" onClick={() => submitResponse({ action: "order-confirm", finalMoq, finalMessage })} disabled={submitting || !finalMoq.trim() || !finalMessage.trim()}>{submitting ? <Loader /> : "Confirm Order"}</button></div></div></div>
      )}
      {data?.pages > 1 && (
        <div className="pagination-controls">
          <button className="button quiet" disabled={data.page <= 1} onClick={() => onPage(data.page - 1)}>Previous</button>
          <span>Page {data.page} of {data.pages}</span>
          <button className="button quiet" disabled={data.page >= data.pages} onClick={() => onPage(data.page + 1)}>Next</button>
        </div>
      )}
    </section>
  );
}
function ProductCreateForm({ categoryOptions = [], onSubmit, onCancel }) {
  const [images, setImages] = useState([]);
  const [video, setVideo] = useState(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [tiers, setTiers] = useState([
    { price: "", moqMin: "", moqMax: "" },
    { price: "", moqMin: "", moqMax: "" },
    { price: "", moqMin: "", moqMax: "" },
    { price: "", moqMin: "", moqMax: "" },
  ]);
  const updateTier = (index, field, value) =>
    setTiers((current) =>
      current.map((tier, tierIndex) =>
        tierIndex === index ? { ...tier, [field]: value } : tier,
      ),
    );
  const chooseImages = (event) => {
    const selected = Array.from(event.target.files || []);
    if (images.length + selected.length > 4) {
      setError("Choose up to 4 product images.");
      return;
    }
    setImages((current) => [...current, ...selected]);
    event.target.value = "";
  };
  const submit = async (event) => {
    event.preventDefault();
    setError("");
    if (
      images.length > 4 ||
      tiers.some(
        (tier) =>
          !tier.price.trim() ||
          !tier.moqMin ||
          !tier.moqMax ||
          Number(tier.moqMin) < 1 ||
          Number(tier.moqMax) < Number(tier.moqMin),
      )
    ) {
      setError("Complete all four pricing and MOQ range tiers.");
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({ event, images, video, tiers });
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div
      className="contact-overlay product-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onCancel();
      }}
    >
      <form
        className="contact-modal product-form-modal"
        onSubmit={submit}
        noValidate
      >
        <div className="modal-heading">
          <div>
            <div className="eyebrow">PRODUCT SETUP</div>
            <h2>Add product</h2>
            <p>Create a product with clear wholesale terms.</p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onCancel}
            disabled={submitting}
            aria-label="Close product form"
          >
            <X size={18} />
          </button>
        </div>
        <div className="product-form-grid">
          <label>
            Product Title
            <input
              required
              name="title"
              placeholder="Enter the product title"
            />
          </label>
          <label>
            Category
            <select
              required
              name="category"
              defaultValue={categoryOptions[0]?.name || ""}
            >
              {categoryOptions.map((category) => (
                <option key={category._id} value={category.name}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <label className="product-form-wide">
            Short Description
            <textarea
              required
              name="shortDescription"
              placeholder="Describe the product for buyers"
            />
          </label>
        </div>
        <fieldset className="tier-fieldset">
          <legend>Pricing &amp; MOQ Tiers</legend>
          <div className="tier-head">
            <span>Price</span>
            <span>MOQ range</span>
          </div>
          {tiers.map((tier, index) => (
            <div className="tier-row" key={index}>
              <input
                required
                aria-label={`Tier ${index + 1} price`}
                placeholder="$10.00"
                value={tier.price}
                onChange={(event) =>
                  updateTier(index, "price", event.target.value)
                }
              />
              <div className="range-inputs">
                <input
                  required
                  type="number"
                  min="1"
                  aria-label={`Tier ${index + 1} minimum quantity`}
                  placeholder="1"
                  value={tier.moqMin}
                  onChange={(event) =>
                    updateTier(index, "moqMin", event.target.value)
                  }
                />
                <span>to</span>
                <input
                  required
                  type="number"
                  min="1"
                  aria-label={`Tier ${index + 1} maximum quantity`}
                  placeholder="2"
                  value={tier.moqMax}
                  onChange={(event) =>
                    updateTier(index, "moqMax", event.target.value)
                  }
                />
                <span>units</span>
              </div>
            </div>
          ))}
        </fieldset>
        <label className="media-label">
          Product Images
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            multiple
            onChange={chooseImages}
          />
          <small>{images.length}/4 images selected</small>
        </label>
        {images.length > 0 && (
          <div className="product-previews">
            {images.map((image, index) => (
              <div className="product-preview" key={`${image.name}-${index}`}>
                <img src={URL.createObjectURL(image)} alt="" />
                <button
                  type="button"
                  onClick={() =>
                    setImages((current) =>
                      current.filter((_, imageIndex) => imageIndex !== index),
                    )
                  }
                  aria-label={`Remove image ${index + 1}`}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        <label className="media-label">
          Product Video
          <input
            type="file"
            accept="video/mp4,video/webm,video/quicktime"
            onChange={(event) => setVideo(event.target.files?.[0] || null)}
          />
          <small>
            {video ? video.name : "One MP4, WebM, or MOV file up to 100 MB"}
          </small>
        </label>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button quiet"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={submitting || !categoryOptions.length}
          >
            {submitting ? <Loader /> : "Add product"}{" "}
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}
function ProductForm({ categoryOptions = [], onSubmit, onCancel, product }) {
  if (product)
    return (
      <ProductEditForm
        product={product}
        categoryOptions={categoryOptions}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );
  return (
    <ProductCreateForm
      categoryOptions={categoryOptions}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}
function ProductEditForm({ product, categoryOptions, onSubmit, onCancel }) {
  const [tiers, setTiers] = useState(product.priceTiers || product.tiers || []);
  const [images, setImages] = useState(product.images || []);
  const [newImages, setNewImages] = useState([]);
  const [video, setVideo] = useState(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const updateTier = (index, field, value) =>
    setTiers((current) =>
      current.map((tier, tierIndex) =>
        tierIndex === index ? { ...tier, [field]: value } : tier,
      ),
    );
  const chooseImages = (event) => {
    const selected = Array.from(event.target.files || []);
    if (images.length + newImages.length + selected.length > 4) {
      setError("Choose up to 4 product images.");
      return;
    }
    setNewImages((current) => [...current, ...selected]);
    event.target.value = "";
  };
  const submit = async (event) => {
    event.preventDefault();
    if (
      tiers.length !== 4 ||
      tiers.some(
        (tier) =>
          !tier.price?.trim() ||
          Number(tier.moqMin) < 1 ||
          Number(tier.moqMax) < Number(tier.moqMin),
      )
    ) {
      setError("Complete all four pricing and MOQ range tiers.");
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        event,
        images: newImages,
        video,
        tiers,
        productId: product._id,
        existingImages: images,
        existingVideo: product.video || "",
      });
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div
      className="contact-overlay product-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onCancel();
      }}
    >
      <form className="contact-modal product-form-modal" onSubmit={submit}>
        <div className="modal-heading">
          <div>
            <div className="eyebrow">PRODUCT SETUP</div>
            <h2>Edit product</h2>
            <p>Update the product and wholesale terms.</p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onCancel}
            disabled={submitting}
            aria-label="Close product form"
          >
            <X size={18} />
          </button>
        </div>
        <div className="product-form-grid">
          <label>
            Product Title
            <input
              required
              name="title"
              defaultValue={product.title || product.name}
            />
          </label>
          <label>
            Category
            <select required name="category" defaultValue={product.category}>
              {categoryOptions.map((category) => (
                <option key={category._id} value={category.name}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <label className="product-form-wide">
            Short Description
            <textarea
              required
              name="shortDescription"
              defaultValue={product.shortDescription || product.description}
            />
          </label>
        </div>
        <fieldset className="tier-fieldset">
          <legend>Pricing &amp; MOQ Tiers</legend>
          {tiers.map((tier, index) => (
            <div className="tier-row" key={index}>
              <input
                required
                aria-label={`Tier ${index + 1} price`}
                value={tier.price}
                onChange={(event) =>
                  updateTier(index, "price", event.target.value)
                }
              />
              <div className="range-inputs">
                <input
                  required
                  type="number"
                  min="1"
                  aria-label={`Tier ${index + 1} minimum quantity`}
                  value={tier.moqMin}
                  onChange={(event) =>
                    updateTier(index, "moqMin", event.target.value)
                  }
                />
                <span>to</span>
                <input
                  required
                  type="number"
                  min="1"
                  aria-label={`Tier ${index + 1} maximum quantity`}
                  value={tier.moqMax}
                  onChange={(event) =>
                    updateTier(index, "moqMax", event.target.value)
                  }
                />
                <span>units</span>
              </div>
            </div>
          ))}
        </fieldset>
        <label className="media-label">
          Product Images
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            multiple
            onChange={chooseImages}
          />
          <small>{images.length + newImages.length}/4 images selected</small>
        </label>
        <div className="product-previews">
          {images.map((image) => (
            <div className="product-preview" key={image}>
              <img src={mediaUrl(image)} alt="" />
              <button
                type="button"
                onClick={() =>
                  setImages((current) =>
                    current.filter((item) => item !== image),
                  )
                }
                aria-label="Remove existing image"
              >
                <X size={14} />
              </button>
            </div>
          ))}
          {newImages.map((image, index) => (
            <div className="product-preview" key={`${image.name}-${index}`}>
              <img src={URL.createObjectURL(image)} alt="" />
              <button
                type="button"
                onClick={() =>
                  setNewImages((current) =>
                    current.filter((_, itemIndex) => itemIndex !== index),
                  )
                }
                aria-label="Remove new image"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
        <label className="media-label">
          Product Video
          <input
            type="file"
            accept="video/mp4,video/webm,video/quicktime"
            onChange={(event) => setVideo(event.target.files?.[0] || null)}
          />
          <small>
            {video
              ? video.name
              : product.video
                ? "Existing video retained unless replaced"
                : "One MP4, WebM, or MOV file up to 100 MB"}
          </small>
        </label>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button quiet"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={submitting}
          >
            {submitting ? <Loader /> : "Update product"}{" "}
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}
function CategoryForm({
  category,
  setCategory,
  onSubmit,
  onCancel,
  submitting,
}) {
  if (category.__productModal)
    return (
      <ProductForm
        categoryOptions={category.categoryOptions}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );
  if (category.__productEdit)
    return (
      <ProductForm
        product={category.product}
        categoryOptions={category.categoryOptions}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );
  const editing = Boolean(category._id);
  return (
    <div
      className="contact-overlay category-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="category-form-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <form
        className="contact-modal category-form"
        onSubmit={onSubmit}
        encType="multipart/form-data"
      >
        <div className="modal-heading">
          <div>
            <div className="eyebrow">CATEGORY SETUP</div>
            <h2 id="category-form-title">
              {editing ? "Edit category" : "Add category"}
            </h2>
            <p>
              {editing
                ? "Update this marketplace collection."
                : "Define a collection for your marketplace."}
            </p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onCancel}
            aria-label="Close category form"
          >
            <X size={18} />
          </button>
        </div>
        <label>
          Category Name
          <input
            required
            name="name"
            value={category.name}
            onChange={(event) =>
              setCategory({ ...category, name: event.target.value })
            }
            placeholder="Enter the category name"
          />
        </label>
        <label>
          Description
          <textarea
            required
            name="description"
            value={category.description}
            onChange={(event) =>
              setCategory({ ...category, description: event.target.value })
            }
            placeholder="Describe this category"
          />
        </label>
        <label>
          {editing ? "Replace Image (optional)" : "Category Image"}
          <input
            required={!editing}
            type="file"
            name="image"
            accept="image/jpeg,image/png,image/webp,image/gif"
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="button quiet" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={submitting}
          >
            {submitting
              ? <Loader />
              : editing
                ? "Update category"
                : "Save category"}{" "}
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}

function VendorForm({
  categoryOptions: initialCategoryOptions,
  onSubmit,
  onCancel,
  vendor,
}) {
  const [form, setForm] = useState(() =>
    vendor
      ? {
        ownerName: vendor.ownerName || "",
        registeredBusinessName: vendor.registeredBusinessName || "",
        registeredBusinessAddress: vendor.registeredBusinessAddress || "",
        registeredPhoneNumber: vendor.registeredPhoneNumber || "",
        registeredEmailAddress: vendor.registeredEmailAddress || "",
        category: vendor.category || "",
      }
      : {
        ownerName: "",
        registeredBusinessName: "",
        registeredBusinessAddress: "",
        registeredPhoneNumber: "",
        registeredEmailAddress: "",
        category: "",
      },
  );
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [loadedCategoryOptions, setLoadedCategoryOptions] = useState([]);
  useEffect(() => {
    if (!initialCategoryOptions?.length)
      getJson("/categories?page=1&limit=100", 30000)
        .then((result) => setLoadedCategoryOptions(result.data || []))
        .catch(() => { });
  }, [initialCategoryOptions]);
  const categoryOptions = initialCategoryOptions?.length
    ? initialCategoryOptions
    : loadedCategoryOptions.length
      ? loadedCategoryOptions
      : vendor
        ? [{ _id: vendor.category, name: vendor.category }]
        : [];
  const update = (field, value) =>
    setForm((current) => ({ ...current, [field]: value }));
  const submit = async (event) => {
    event.preventDefault();
    setError("");
    const values = Object.fromEntries(
      Object.entries(form).map(([key, value]) => [key, value.trim()]),
    );
    if (Object.values(values).some((value) => !value) || !values.category) {
      setError("Complete all vendor fields.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.registeredEmailAddress)) {
      setError("Enter a valid email address.");
      return;
    }
    if (!/^\+?[\d\s().-]{7,20}$/.test(values.registeredPhoneNumber)) {
      setError("Enter a valid phone number.");
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(values);
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div
      className="contact-overlay category-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="vendor-form-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onCancel();
      }}
    >
      <form
        className="contact-modal category-form vendor-form"
        onSubmit={submit}
        noValidate
      >
        <div className="modal-heading">
          <div>
            <div className="eyebrow">VENDOR SETUP</div>
            <h2 id="vendor-form-title">Add vendor</h2>
            <p>Register a vendor for your marketplace.</p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onCancel}
            disabled={submitting}
            aria-label="Close vendor form"
          >
            <X size={18} />
          </button>
        </div>
        <label>
          Owner Name
          <input
            required
            value={form.ownerName}
            onChange={(event) => update("ownerName", event.target.value)}
            placeholder="Enter the owner name"
          />
        </label>
        <label>
          Registered Business Name
          <input
            required
            value={form.registeredBusinessName}
            onChange={(event) =>
              update("registeredBusinessName", event.target.value)
            }
            placeholder="Enter the registered business name"
          />
        </label>
        <label>
          Registered Business Address
          <textarea
            required
            value={form.registeredBusinessAddress}
            onChange={(event) =>
              update("registeredBusinessAddress", event.target.value)
            }
            placeholder="Enter the registered business address"
          />
        </label>
        <label>
          Registered Phone Number
          <input
            required
            value={form.registeredPhoneNumber}
            onChange={(event) =>
              update("registeredPhoneNumber", event.target.value)
            }
            placeholder="Enter the registered phone number"
            inputMode="tel"
          />
        </label>
        <label>
          Registered Email Address
          <input
            required
            type="email"
            value={form.registeredEmailAddress}
            onChange={(event) =>
              update("registeredEmailAddress", event.target.value)
            }
            placeholder="Enter the registered email address"
          />
        </label>
        <label>
          Category
          <select
            required
            value={form.category}
            onChange={(event) => update("category", event.target.value)}
          >
            <option value="">Select Category</option>
            {categoryOptions.map((category) => (
              <option key={category._id} value={category.name}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button quiet"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={submitting}
          >
            {submitting ? <Loader /> : "Save vendor"} <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}
function DeleteCategoryModal({
  category,
  error,
  deleting,
  onCancel,
  onConfirm,
}) {
  return (
    <div
      className="contact-overlay category-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-category-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="contact-modal delete-category-modal">
        <div className="modal-heading">
          <div>
            <div className="eyebrow">CATEGORY MANAGEMENT</div>
            <h2 id="delete-category-title">Delete category?</h2>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onCancel}
            disabled={deleting}
            aria-label="Close delete confirmation"
          >
            <X size={18} />
          </button>
        </div>
        <p className="delete-category-copy">
          Are you sure you want to delete this category? This action cannot be
          undone.
        </p>
        <div className="delete-category-name">{category.name}</div>
        {category.productCount > 0 && (
          <div className="form-error" role="alert">
            This category contains {category.productCount} active product
            {category.productCount === 1 ? "" : "s"}. Reassign them before
            deleting it.
          </div>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button quiet"
            onClick={onCancel}
            disabled={deleting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button danger"
            onClick={onConfirm}
            disabled={deleting || category.productCount > 0}
          >
            {deleting ? <Loader /> : <>Delete <Trash2 size={15} /></>}
          </button>
        </div>
      </div>
    </div>
  );
}
function ProfileWorkspace() {
  const user = storedUser();
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({
    fullName: user.fullName || "",
    emailAddress: user.emailAddress || "",
    phoneNumber: user.phoneNumber || "",
    designation: user.designation || "Employee",
  });
  const initials = (form.fullName || "User")
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const update = (field, value) =>
    setForm((current) => ({ ...current, [field]: value }));
  const save = (event) => {
    event.preventDefault();
    localStorage.setItem(
      "omni-dashboard-user",
      JSON.stringify({ ...user, ...form }),
    );
    setEditing(false);
    setNotice("Profile details saved locally for this workspace.");
    setTimeout(() => setNotice(""), 3500);
  };
  return (
    <section className="profile-workspace">
      <div className="profile-hero">
        <div className="profile-identity">
          <span className="profile-avatar">{initials}</span>
          <div>
            <div className="eyebrow">ACCOUNT PROFILE</div>
            <h2>{form.fullName || "Workspace user"}</h2>
            <p>{form.designation} · Vendor Woo operations</p>
          </div>
        </div>
        <button
          className="button quiet profile-edit-button"
          onClick={() => setEditing((current) => !current)}
        >
          <Pencil size={15} /> {editing ? "Cancel editing" : "Edit profile"}
        </button>
      </div>
      {notice && (
        <div className="dashboard-notice" role="status">
          <CheckCircle2 size={16} /> {notice}
        </div>
      )}
      <form className="profile-grid" onSubmit={save}>
        <section className="profile-card profile-details-card">
          <div className="profile-card-heading">
            <span className="profile-card-icon">
              <Building2 size={17} />
            </span>
            <div>
              <h3>Business profile</h3>
              <p>Your identity within the marketplace workspace.</p>
            </div>
          </div>
          <div className="profile-fields">
            <label>
              Full name
              <input
                disabled={!editing}
                value={form.fullName}
                onChange={(event) => update("fullName", event.target.value)}
              />
            </label>
            <label>
              Role
              <input disabled value={form.designation} />
            </label>
          </div>
        </section>
        <section className="profile-card">
          <div className="profile-card-heading">
            <span className="profile-card-icon">
              <Mail size={17} />
            </span>
            <div>
              <h3>Contact information</h3>
              <p>How your team can reach you.</p>
            </div>
          </div>
          <div className="profile-fields">
            <label>
              Email address
              <input
                disabled={!editing}
                type="email"
                value={form.emailAddress}
                onChange={(event) => update("emailAddress", event.target.value)}
              />
            </label>
            <label>
              Phone number
              <input
                disabled={!editing}
                value={form.phoneNumber}
                onChange={(event) => update("phoneNumber", event.target.value)}
                placeholder="Add a phone number"
              />
            </label>
          </div>
        </section>
        <section className="profile-card profile-account-card">
          <div className="profile-card-heading">
            <span className="profile-card-icon">
              <ShieldCheck size={17} />
            </span>
            <div>
              <h3>Account access</h3>
              <p>Security and workspace access details.</p>
            </div>
          </div>
          <div className="profile-access-row">
            <span>
              <strong>Access level</strong>
              <small>{form.designation} permissions</small>
            </span>
            <span className="profile-status">
              <CheckCircle2 size={15} /> Active
            </span>
          </div>
          <div className="profile-access-row">
            <span>
              <strong>Sign-in email</strong>
              <small>{form.emailAddress || "Not provided"}</small>
            </span>
            <span className="profile-secure">Protected</span>
          </div>
        </section>
        {editing && (
          <div className="profile-actions">
            <button
              type="button"
              className="button quiet"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <button type="submit" className="button primary">
              Save changes <Check size={16} />
            </button>
          </div>
        )}
      </form>
    </section>
  );
}
function MarketplaceVoiceNote({ attachment, messageId }) {
  const audioRef = useRef(null);
  const mountedRef = useRef(true);
  const [state, setState] = useState({ duration: 0, currentTime: 0, isPlaying: false, error: "" });
  const [playbackRate, setPlaybackRate] = useState(1);
  const audioKey = `${messageId}-${attachment.fileName}`;
  const duration = Number.isFinite(state.duration) ? state.duration : 0;
  const progress = duration ? ((state.currentTime || 0) / duration) * 100 : 0;
  const audioSource = attachment.url?.startsWith("blob:")
    ? attachment.url
    : `${API_ORIGIN}${attachment.url}?media=audio`;
  useEffect(() => () => { mountedRef.current = false; }, []);
  const updateState = (nextState) => { if (mountedRef.current) setState((current) => ({ ...current, ...nextState })); };
  const togglePlayback = async () => {
    if (!audioRef.current) return;
    if (audioRef.current.paused) {
      try { await audioRef.current.play(); } catch { updateState({ isPlaying: false, error: "Voice note could not be played." }); }
    } else audioRef.current.pause();
  };
  const formatDuration = (value) => Number.isFinite(value) && value >= 0 ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}` : "0:00";
  const cycleRate = () => setPlaybackRate((current) => current === 1 ? 1.5 : current === 1.5 ? 2 : 1);
  useEffect(() => { if (audioRef.current) audioRef.current.playbackRate = playbackRate; }, [playbackRate]);
  return <div className="message-audio-host">
    <div className="voice-note-card">
      <button type="button" className={`voice-note-play ${state.isPlaying ? "playing" : ""}`} onClick={() => void togglePlayback()} aria-label={state.isPlaying ? "Pause voice note" : "Play voice note"}>
        {state.isPlaying ? <span className="voice-note-pause-icon" aria-hidden="true" /> : <span className="voice-note-play-icon" aria-hidden="true" />}
      </button>
      <div className="voice-note-body">
        <div className="voice-note-head"><span className="voice-note-time">{formatDuration(state.currentTime || 0)}</span><span className="voice-note-duration">{formatDuration(duration)}</span></div>
        <div className="voice-note-waveform-row"><div className="voice-note-waveform" aria-label="Voice waveform"><div className="voice-note-waveform-progress" style={{ width: `${Math.min(Math.max(progress, 0), 100)}%` }} />{voiceWaveformBars.map((barHeight, index) => <span key={`${audioKey}-${index}`} className="voice-note-bar" style={{ height: `${Math.max(10, barHeight * 100)}%`, opacity: index / voiceWaveformBars.length <= progress / 100 ? 1 : 0.38 }} />)}</div><button type="button" className="message-speed-toggle" onClick={cycleRate}>{playbackRate}x</button></div>
        {state.error && <span className="voice-note-error" role="status">{state.error}</span>}
      </div>
    </div>
    <audio ref={audioRef} className="message-audio" src={audioSource} preload="metadata" onLoadedMetadata={(event) => updateState({ duration: Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0, error: "" })} onTimeUpdate={(event) => updateState({ currentTime: Number.isFinite(event.currentTarget.currentTime) ? event.currentTarget.currentTime : 0 })} onPlay={() => updateState({ isPlaying: true, error: "" })} onPause={() => updateState({ isPlaying: false })} onEnded={() => updateState({ isPlaying: false, currentTime: 0 })} onError={() => updateState({ isPlaying: false, error: "Voice note could not be loaded." })} onRateChange={(event) => setPlaybackRate(Number.isFinite(event.currentTarget.playbackRate) ? event.currentTarget.playbackRate : 1)} />
  </div>;
}

function ProductContextCard({ attachment }) {
  return (
    <div className="product-message-card">
      {attachment.productImage ? (
        <img src={mediaUrl(attachment.productImage)} alt="" />
      ) : (
        <span className="product-message-placeholder"><Package size={18} /></span>
      )}
      <div>
        <small>Product enquiry</small>
        <strong>{attachment.productTitle || attachment.fileName}</strong>
        <span>MOQ: {attachment.productMoq || "Not specified"}</span>
      </div>
    </div>
  );
}

function ImageAttachment({ attachment }) {
  const [open, setOpen] = useState(false);
  const imageUrl = `${API_ORIGIN}${attachment.url}?media=${encodeURIComponent(attachment.mimeType || "image/*")}`;

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="message-image-button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
        aria-label={`Open ${attachment.fileName || "image"}`}
      >
        <img src={imageUrl} alt={attachment.fileName || "Chat attachment"} />
      </button>
      {open ? (
        <div
          className="attachment-image-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={attachment.fileName || "Image preview"}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div className="attachment-image-modal">
            <button
              type="button"
              className="modal-close"
              onClick={() => setOpen(false)}
              aria-label="Close image preview"
            >
              <X size={18} />
            </button>
            <img src={imageUrl} alt={attachment.fileName || "Image preview"} />
          </div>
        </div>
      ) : null}
    </>
  );
}

function getAttachmentFileType(attachment) {
  const fileName = attachment.fileName || "";
  const extension = fileName.split(".").pop()?.toLowerCase() || "file";
  const mimeType = attachment.mimeType || "";
  if (attachment.kind === "pdf" || mimeType === "application/pdf" || extension === "pdf") {
    return { category: "pdf", label: "PDF", Icon: FileText };
  }
  if (attachment.kind === "video" || mimeType.startsWith("video/")) {
    return { category: "video", label: extension.toUpperCase(), Icon: File };
  }
  if (mimeType.includes("word") || ["doc", "docx"].includes(extension)) {
    return { category: "word", label: extension.toUpperCase(), Icon: FileText };
  }
  if (mimeType.includes("spreadsheet") || mimeType === "application/vnd.ms-excel" || ["xls", "xlsx", "csv"].includes(extension)) {
    return { category: "excel", label: extension.toUpperCase(), Icon: FileSpreadsheet };
  }
  if (mimeType.includes("presentation") || ["ppt", "pptx"].includes(extension)) {
    return { category: "presentation", label: extension.toUpperCase(), Icon: FileText };
  }
  if (["zip", "rar", "7z", "tar", "gz"].includes(extension)) {
    return { category: "archive", label: extension.toUpperCase(), Icon: FileArchive };
  }
  if (mimeType.startsWith("text/") || ["json", "xml", "md"].includes(extension)) {
    return { category: "text", label: extension.toUpperCase(), Icon: FileText };
  }
  return { category: "file", label: extension.toUpperCase(), Icon: File };
}

function AttachmentFileCard({ attachment }) {
  const fileType = getAttachmentFileType(attachment);
  const { Icon } = fileType;
  return (
    <a
      className={`message-file attachment-file-card attachment-file-card-${fileType.category}`}
      href={`${API_ORIGIN}${attachment.url}`}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
    >
      <span className="attachment-file-icon" aria-hidden="true">
        <Icon size={18} />
        <small>{fileType.label}</small>
      </span>
      <span className="attachment-file-copy">
        <strong>{attachment.fileName || "Attachment"}</strong>
        <small>{fileType.category === "file" ? "File attachment" : `${fileType.label} file`}</small>
      </span>
      <ArrowRight size={12} />
    </a>
  );
}

function CustomerChatPanel({ customer, onClose, open, productContext }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [olderLoading, setOlderLoading] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const threadRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const recordingTimerRef = useRef(null);
  const recordingStartingRef = useRef(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const mountedRef = useRef(true);
  const keepThreadAtBottomRef = useRef(true);
  const productContextSendingRef = useRef("");
  const oldestMessageCursorRef = useRef(null);
  const olderLoadingRef = useRef(false);
  const initialLoadingRef = useRef(true);
  const openingScrollRef = useRef(false);

  const request = async (path, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (!(options.body instanceof FormData))
      headers["Content-Type"] = "application/json";
    const response = await fetch(`${API_URL}${path}`, {
      credentials: "include",
      cache: "no-store",
      ...options,
      headers,
    });
    return response.status === 204 ? null : parseResponse(response);
  };

  const loadMessages = async (showLoading = true) => {
    if (showLoading) {
      initialLoadingRef.current = true;
      setLoading(true);
    }
    try {
      const result = await request("/messages/customer?limit=15");
      setMessages(result.messages || []);
      oldestMessageCursorRef.current = result.nextCursor || null;
      setHasOlderMessages(Boolean(result.hasMore));
      setError("");
      return result;
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      if (showLoading) {
        initialLoadingRef.current = false;
        setLoading(false);
      }
    }
  };

  const refreshLatestMessages = async () => {
    try {
      const result = await request("/messages/customer?limit=15");
      setMessages((current) => {
        const byId = new Map(current.map((message) => [String(message._id), message]));
        (result.messages || []).forEach((message) => byId.set(String(message._id), message));
        return [...byId.values()].sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt));
      });
      setError("");
    } catch (refreshError) {
      setError(refreshError.message);
    }
  };

  const loadOlderMessages = async () => {
    const cursor = oldestMessageCursorRef.current;
    if (olderLoadingRef.current || !hasOlderMessages || !cursor) return;
    const thread = threadRef.current;
    const previousHeight = thread?.scrollHeight || 0;
    const previousTop = thread?.scrollTop || 0;
    olderLoadingRef.current = true;
    setOlderLoading(true);
    try {
      const params = new URLSearchParams({
        limit: "15",
        beforeCreatedAt: cursor.createdAt,
        beforeId: cursor.id,
      });
      const result = await request(`/messages/customer?${params.toString()}`);
      setMessages((current) => {
        const existingIds = new Set(current.map((message) => String(message._id)));
        return [
          ...(result.messages || []).filter((message) => !existingIds.has(String(message._id))),
          ...current,
        ];
      });
      oldestMessageCursorRef.current = result.nextCursor || null;
      setHasOlderMessages(Boolean(result.hasMore));
      requestAnimationFrame(() => {
        if (thread) thread.scrollTop = thread.scrollHeight - previousHeight + previousTop;
      });
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      olderLoadingRef.current = false;
      setOlderLoading(false);
    }
  };

  const sendProductContext = async (existingMessages) => {
    if (!productContext?.productId || !productContext?.selectedMoq) return;
    const contextKey = `${productContext.productId}:${productContext.selectedMoq}`;
    if (productContextSendingRef.current === contextKey) return;
    productContextSendingRef.current = contextKey;
    try {
      const formData = new FormData();
      formData.append("productContext", JSON.stringify(productContext));
      const result = await fetch(`${API_URL}/messages/customer`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { ...authHeaders() },
        body: formData,
      }).then(parseResponse);
      setMessages((current) => current.some((message) => String(message._id) === String(result.message?._id)) ? current : [...current, result.message]);
      notifyMessagesChange();
    } catch (sendError) {
      productContextSendingRef.current = "";
      setError(sendError.message);
    }
  };

  useEffect(() => {
    if (!open || !customer) {
      productContextSendingRef.current = "";
      return undefined;
    }
    keepThreadAtBottomRef.current = true;
    initialLoadingRef.current = true;
    olderLoadingRef.current = false;
    oldestMessageCursorRef.current = null;
    setHasOlderMessages(false);
    setOlderLoading(false);
    setMessages([]);
    openingScrollRef.current = true;
    loadMessages().then(async (result) => {
      await sendProductContext(result?.messages || []);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (threadRef.current) {
            threadRef.current.scrollTop = threadRef.current.scrollHeight;
          }
          openingScrollRef.current = false;
        });
      });
    });
    const refresh = () => refreshLatestMessages();
    const markRead = async () => {
      try {
        const response = await fetch(`${API_URL}/messages/customer/read`, {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
        });
        if (response.ok) notifyMessagesChange();
      } catch {
        // ignore read-state failures and rely on the next refresh cycle.
      }
    };
    void markRead();
    const pollingTimer = setInterval(() => {
      refresh();
      markRead();
    }, 2500);
    const onStorage = (event) => {
      if (event.key === messageSyncKey) refresh();
    };
    window.addEventListener("storage", onStorage);
    messageSyncChannel?.addEventListener("message", refresh);
    return () => {
      window.removeEventListener("storage", onStorage);
      messageSyncChannel?.removeEventListener("message", refresh);
      clearInterval(pollingTimer);
    };
  }, [open, customer, productContext?.productId, productContext?.selectedMoq, productContext?.title, productContext?.image]);

  useEffect(() => {
    if (!threadRef.current || (!keepThreadAtBottomRef.current && !openingScrollRef.current)) return undefined;
    const scrollToBottom = () => {
      if (threadRef.current && keepThreadAtBottomRef.current) {
        threadRef.current.scrollTop = threadRef.current.scrollHeight;
      }
    };
    const firstFrame = requestAnimationFrame(() => {
      scrollToBottom();
      requestAnimationFrame(scrollToBottom);
    });
    return () => cancelAnimationFrame(firstFrame);
  }, [messages, loading]);

  const handleThreadScroll = () => {
    const thread = threadRef.current;
    if (!thread || loading || initialLoadingRef.current || openingScrollRef.current) return;
    keepThreadAtBottomRef.current = thread.scrollHeight - thread.scrollTop - thread.clientHeight <= 48;
    if (thread.scrollTop <= 48) void loadOlderMessages();
  };

  const formatRecordingDuration = (totalSeconds) =>
    `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`;

  const stopVoiceRecording = () => {
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = null;
    const recorder = mediaRecorderRef.current;
    setIsRecording(false);
    if (!recorder || recorder.state === "inactive") return;
    try {
      recorder.stop();
    } catch {
      setError("The voice recording could not be stopped. Please try again.");
      recorder.stream?.getTracks().forEach((track) => track.stop());
      mediaRecorderRef.current = null;
    }
  };

  const startVoiceRecording = async () => {
    if (isRecording || recordingStartingRef.current) {
      if (isRecording) stopVoiceRecording();
      return;
    }
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setError("Microphone access is not available in this browser.");
      return;
    }
    recordingStartingRef.current = true;
    let acquiredStream = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      acquiredStream = stream;
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        recordingStartingRef.current = false;
        return;
      }
      const mimeType = getVoiceRecordingMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      const chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunks.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunks, {
          type: recorder.mimeType || mimeType || "audio/webm",
        });
        stream.getTracks().forEach((track) => track.stop());
        if (mediaRecorderRef.current === recorder) mediaRecorderRef.current = null;
        if (streamRef.current === stream) streamRef.current = null;
        if (blob.size && mountedRef.current)
          setFiles((current) => [
            ...current,
            new globalThis.File([blob], `voice-message-${Date.now()}.${getVoiceRecordingExtension(blob.type)}`, {
              type: blob.type,
            }),
          ]);
      };
      mediaRecorderRef.current = recorder;
      streamRef.current = stream;
      recorder.start(250);
      recordingStartingRef.current = false;
      setError("");
      setIsRecording(true);
      setRecordingSeconds(0);
      const startedAt = Date.now();
      recordingTimerRef.current = setInterval(
        () => setRecordingSeconds(Math.floor((Date.now() - startedAt) / 1000)),
        250,
      );
    } catch {
      recordingStartingRef.current = false;
      acquiredStream?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setError(
        "Microphone access was blocked. Please allow microphone permission and try again.",
      );
    }
  };

  useEffect(
    () => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
          try { mediaRecorderRef.current.stop(); } catch { }
        } else streamRef.current?.getTracks().forEach((track) => track.stop());
      };
    },
    [],
  );

  const sendMessage = async (event) => {
    event.preventDefault();
    const text = draft.trim();
    if ((!text && !files.length) || sending) return;
    const filesToSend = [...files];
    const optimisticId = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const optimisticMessage = {
      _id: optimisticId,
      sender: "customer",
      text,
      status: "sent",
      createdAt: new Date().toISOString(),
      attachments: filesToSend.map((file) => ({
        fileName: file.name,
        mimeType: file.type,
        size: file.size,
        url: URL.createObjectURL(file),
        kind: file.type.startsWith("image/")
          ? "image"
          : file.type.startsWith("audio/")
            ? "audio"
            : file.type === "application/pdf"
              ? "pdf"
              : "document",
      })),
    };
    setMessages((current) => [...current, optimisticMessage]);
    setDraft("");
    setFiles([]);
    setSending(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("text", text);
      filesToSend.forEach((file) => formData.append("files", file));
      const result = await fetch(`${API_URL}/messages/customer`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { ...authHeaders() },
        body: formData,
      }).then(parseResponse);
      setMessages((current) => [
        ...current.filter((message) => message._id !== optimisticId && message._id !== result.message._id),
        result.message,
      ]);
      optimisticMessage.attachments.forEach((attachment) => URL.revokeObjectURL(attachment.url));
      notifyMessagesChange();
    } catch (sendError) {
      setMessages((current) => current.filter((message) => message._id !== optimisticId));
      optimisticMessage.attachments.forEach((attachment) => URL.revokeObjectURL(attachment.url));
      setError(sendError.message);
    } finally {
      setSending(false);
    }
  };

  const formatStamp = (value) => formatMarketplaceDateTime(value);

  return (
    <div className={`customer-live-chat-overlay${open ? " is-open" : ""}`} aria-hidden={!open}>
      <div className="customer-live-chat-panel" role="dialog" aria-modal="false">
        <div className="live-chat-header">
          <div>
            <h2>Live Chat</h2>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close live chat"
          >
            <X size={18} />
          </button>
        </div>
        <div ref={threadRef} className="messages-thread customer-thread" onScroll={handleThreadScroll}>
          {!loading && olderLoading && <div className="older-messages-loader"><Loader /></div>}
          {loading ? (
            <Loader />
          ) : messages.length ? (
            messages.map((message) => {
              const isOutgoing = message.sender === "customer";
              const isRead = isOutgoing && message.status === "read";
              return (
                <div
                  key={message._id}
                  className={`message-row ${isOutgoing ? "outgoing" : ""}`}
                >
                  <div className="message-bubble">
                    <div className="message-meta">
                      <strong>{isOutgoing ? "You" : "Vendor"}</strong>
                      <time>{formatStamp(message.createdAt)}</time>
                    </div>
                    {message.text && <p>{message.text}</p>}
                    {message.attachments?.length ? (
                      <div className="message-attachments">
                        {message.attachments.map((attachment, index) => {
                          if (attachment.kind === "product") {
                            return <ProductContextCard key={`${message._id}-${index}`} attachment={attachment} />;
                          }
                          const isAudio = attachment.kind === "audio" || attachment.mimeType?.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|webm)$/i.test(attachment.fileName || "");
                          const isImage = attachment.kind === "image" || attachment.mimeType?.startsWith("image/") || /\.(avif|gif|jpe?g|png|webp)$/i.test(attachment.fileName || "");
                          if (isImage) {
                            return <ImageAttachment key={`${message._id}-${index}`} attachment={attachment} />;
                          }
                          return isAudio ? (
                            <MarketplaceVoiceNote key={`${message._id}-${index}`} messageId={message._id} attachment={attachment} />
                          ) : (
                            <AttachmentFileCard key={`${message._id}-${index}`} attachment={attachment} />
                          );
                        })}
                      </div>
                    ) : null}
                    {isOutgoing ? (
                      <span
                        className={`message-status-check outgoing ${isRead ? "read" : ""}`}
                        aria-label="Message status"
                      >
                        ✓✓
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="messages-empty">
              Start a conversation with our team.
            </div>
          )}
        </div>
        <form
          className="messages-composer customer-composer"
          onSubmit={sendMessage}
        >
          <div className="messages-attachment-preview">
            {files.map((file, index) => (
              <span key={`${file.name}-${index}`} className="attachment-chip">
                <span>{file.name}</span>
                <button
                  type="button"
                  className="attachment-remove"
                  onClick={() =>
                    setFiles((current) =>
                      current.filter((_, itemIndex) => itemIndex !== index),
                    )
                  }
                  aria-label={`Remove ${file.name}`}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
          {isRecording && (
            <div className="messages-recording-bar">
              <span className="messages-recording-indicator" />
              <span>Recording {formatRecordingDuration(recordingSeconds)}</span>
              <button type="button" className="messages-recording-stop" onClick={stopVoiceRecording}>Stop</button>
            </div>
          )}
          <div className="messages-composer-row">
            <label className="messages-upload" aria-label="Attach file">
              <Paperclip size={15} />
              <input
                type="file"
                multiple
                onChange={(event) => {
                  const nextFiles = Array.from(event.target.files || []);
                  setFiles((current) => [...current, ...nextFiles]);
                  event.target.value = "";
                }}
              />
            </label>
            <textarea
              value={draft}
              rows={1}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (!sending && (draft.trim() || files.length)) {
                    void sendMessage(event);
                  }
                }
              }}
              placeholder="Write a message..."
              aria-label="Message"
            />
            <button type="button" className={`messages-mic-button ${isRecording ? "recording" : ""}`} onClick={startVoiceRecording} aria-label={isRecording ? "Stop recording" : "Record voice message"} disabled={sending}>
              {isRecording ? <MicOff size={15} /> : <Mic size={15} />}
            </button>
            <button
              type="submit"
              className="messages-send-button"
              disabled={sending || (!draft.trim() && !files.length)}
              aria-label="Send message"
            >
              <Send size={15} />
            </button>
          </div>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

function MessagesWorkspace() {
  const [contacts, setContacts] = useState([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState(() => new URLSearchParams(window.location.search).get("customerId") || "");
  const [search, setSearch] = useState("");
  const [messages, setMessages] = useState([]);
  const [customer, setCustomer] = useState(null);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [activeMessageActions, setActiveMessageActions] = useState("");
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [editDraft, setEditDraft] = useState("");
  const [voicePlaybackRates, setVoicePlaybackRates] = useState({});
  const [voiceStates, setVoiceStates] = useState({});
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const recordingTimerRef = useRef(null);
  const recordingStartingRef = useRef(false);
  const mountedRef = useRef(true);
  const audioRefs = useRef({});
  const threadRef = useRef(null);
  const keepThreadAtBottomRef = useRef(true);

  const request = async (path, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (!(options.body instanceof FormData))
      headers["Content-Type"] = "application/json";
    const response = await fetch(`${API_URL}${path}`, {
      cache: "no-store",
      ...options,
      headers: { ...authHeaders(), ...headers },
    });
    return response.status === 204 ? null : parseResponse(response);
  };

  const getVoicePlaybackLabel = (value = 1) => {
    if (value === 1.5) return "1.5x";
    if (value === 2) return "2x";
    return "1x";
  };

  const getNextVoicePlaybackRate = (value = 1) => {
    const rates = [1, 1.5, 2];
    const currentIndex = rates.indexOf(value);
    return rates[(currentIndex + 1) % rates.length];
  };

  const cycleVoicePlaybackRate = (messageId) => {
    setVoicePlaybackRates((current) => {
      const previous = current[messageId] ?? 1;
      return { ...current, [messageId]: getNextVoicePlaybackRate(previous) };
    });
  };

  const beginEditingMessage = (message) => {
    setEditingMessageId(message._id);
    setEditDraft(message.text || "");
    setActiveMessageActions("");
  };

  const saveEditedMessage = (messageId) => {
    const trimmedText = editDraft.trim();
    setMessages((current) =>
      current.map((message) =>
        message._id === messageId ? { ...message, text: trimmedText } : message,
      ),
    );
    setEditingMessageId(null);
    setEditDraft("");
  };

  const deleteMessage = async (messageId) => {
    try {
      await fetch(`${API_URL}/messages/${encodeURIComponent(messageId)}`, {
        method: "DELETE",
        cache: "no-store",
        headers: { ...authHeaders() },
      }).then(parseResponse);
      setMessages((current) =>
        current.filter((message) => String(message._id) !== String(messageId)),
      );
      setActiveMessageActions("");
      setEditingMessageId((current) =>
        current === messageId ? null : current,
      );
      setEditDraft("");
      notifyMessagesChange();
      const refreshed = await request("/messages/customers");
      setContacts(refreshed.data || []);
    } catch (deleteError) {
      setError(deleteError.message);
    }
  };

  const formatRecordingDuration = (totalSeconds) => {
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
  };

  const formatVoiceDuration = (totalSeconds = 0) => {
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "0:00";
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  };

  const stopVoiceRecording = () => {
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    const recorder = mediaRecorderRef.current;
    setIsRecording(false);
    if (!recorder || recorder.state === "inactive") return;
    try {
      recorder.stop();
    } catch {
      setError("The voice recording could not be stopped. Please try again.");
      recorder.stream?.getTracks().forEach((track) => track.stop());
      mediaRecorderRef.current = null;
    }
  };

  const startVoiceRecording = async () => {
    if (isRecording || recordingStartingRef.current) {
      if (isRecording) stopVoiceRecording();
      return;
    }
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setError("Microphone access is not available in this browser.");
      return;
    }

    recordingStartingRef.current = true;
    let acquiredStream = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      acquiredStream = stream;
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        recordingStartingRef.current = false;
        return;
      }
      const mimeType = getVoiceRecordingMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      const chunks = [];

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunks, {
          type: recorder.mimeType || mimeType || "audio/webm",
        });
        stream.getTracks().forEach((track) => track.stop());
        if (mediaRecorderRef.current === recorder) mediaRecorderRef.current = null;
        if (streamRef.current === stream) streamRef.current = null;
        if (blob.size > 0 && mountedRef.current) {
          setFiles((current) => [
            ...current,
            new globalThis.File([blob], `voice-message-${Date.now()}.${getVoiceRecordingExtension(blob.type)}`, {
              type: blob.type || "audio/webm",
            }),
          ]);
        }
      };

      mediaRecorderRef.current = recorder;
      streamRef.current = stream;
      recorder.start();
      recordingStartingRef.current = false;
      setError("");
      setIsRecording(true);
      setRecordingSeconds(0);
      const startedAt = Date.now();
      recordingTimerRef.current = setInterval(() => {
        setRecordingSeconds(Math.floor((Date.now() - startedAt) / 1000));
      }, 250);
    } catch {
      recordingStartingRef.current = false;
      acquiredStream?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setError(
        "Microphone access was blocked. Please allow microphone permission and try again.",
      );
    }
  };

  useEffect(
    () => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
          try { mediaRecorderRef.current.stop(); } catch { }
        } else streamRef.current?.getTracks().forEach((track) => track.stop());
      };
    },
    [],
  );

  const loadContacts = async () => {
    try {
      const result = await request("/messages/customers");
      const nextContacts = result.data || [];
      setContacts(nextContacts);
      setSelectedCustomerId((currentId) => {
        if (
          currentId &&
          nextContacts.some(
            (customer) => String(customer._id) === String(currentId),
          )
        ) return currentId;
        return "";
      });
    } catch (loadError) {
      setError(loadError.message);
      setContacts([]);
      setSelectedCustomerId("");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    loadContacts();
    const refresh = () => loadContacts();
    const onStorage = (event) => {
      if (event.key === messageSyncKey) refresh();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("omni-message-change", refresh);
    messageSyncChannel?.addEventListener("message", refresh);
    const pollingTimer = setInterval(refresh, 1500);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("omni-message-change", refresh);
      messageSyncChannel?.removeEventListener("message", refresh);
      clearInterval(pollingTimer);
    };
  }, []);

  useEffect(() => {
    if (!selectedCustomerId) {
      setCustomer(null);
      setMessages([]);
      return undefined;
    }

    keepThreadAtBottomRef.current = true;
    let cancelled = false;
    request(`/messages?customerId=${encodeURIComponent(selectedCustomerId)}`)
      .then(async (result) => {
        if (cancelled) return;
        setCustomer(result.customer || null);
        setMessages(result.messages || []);
        setError("");
        await request("/messages/read", {
          method: "POST",
          body: JSON.stringify({ customerId: selectedCustomerId }),
        }).catch(() => { });
      })
      .then(() => {
        if (cancelled) return;
        setContacts((current) => current.map((contact) => String(contact._id) === String(selectedCustomerId) ? { ...contact, unreadCount: 0 } : contact));
      })
      .catch((loadError) => {
        if (cancelled) return;
        setCustomer(null);
        setMessages([]);
        setError(loadError.message);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCustomerId]);

  useEffect(() => {
    if (!selectedCustomerId) return undefined;
    let cancelled = false;
    const refreshActiveConversation = () => {
      request(`/messages?customerId=${encodeURIComponent(selectedCustomerId)}`)
        .then((result) => {
          if (cancelled) return;
          setCustomer(result.customer || null);
          setMessages(result.messages || []);
        })
        .then(() => {
          if (cancelled) return;
          setContacts((current) => current.map((contact) => String(contact._id) === String(selectedCustomerId) ? { ...contact, unreadCount: 0 } : contact));
        })
        .catch(() => { });
    };
    const pollingTimer = setInterval(refreshActiveConversation, 1000);
    return () => {
      cancelled = true;
      clearInterval(pollingTimer);
    };
  }, [selectedCustomerId]);

  useEffect(() => {
    if (!threadRef.current || !keepThreadAtBottomRef.current) return;
    const thread = threadRef.current;
    thread.scrollTop = thread.scrollHeight;
  }, [selectedCustomerId, messages]);

  const handleThreadScroll = () => {
    const thread = threadRef.current;
    if (!thread) return;
    keepThreadAtBottomRef.current = thread.scrollHeight - thread.scrollTop - thread.clientHeight <= 48;
  };

  const filteredContacts = contacts.filter((contact) => {
    const query = search.trim().toLowerCase();
    if (!query) return true;
    return `${contact.customerName || ""} ${contact.emailAddress || ""}`
      .toLowerCase()
      .includes(query);
  });

  const selectedContact =
    selectedCustomerId
      ? contacts.find(
        (contact) => String(contact._id) === String(selectedCustomerId),
      ) || customer
      : null;

  const sendMessage = async (event) => {
    event.preventDefault();
    const text = draft.trim();
    if ((!text && !files.length) || !selectedCustomerId || sending) return;

    setSending(true);
    setError("");

    try {
      const formData = new FormData();
      formData.append("customerId", selectedCustomerId);
      formData.append("text", text);
      files.forEach((file) => formData.append("files", file));
      const result = await fetch(`${API_URL}/messages`, {
        method: "POST",
        cache: "no-store",
        headers: { ...authHeaders() },
        body: formData,
      }).then(parseResponse);

      setMessages((current) => [...current, result.message]);
      setDraft("");
      setFiles([]);
      notifyMessagesChange();
      const refreshed = await request("/messages/customers");
      setContacts(refreshed.data || []);
    } catch (sendError) {
      setError(sendError.message);
    } finally {
      setSending(false);
    }
  };

  const handleComposerKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const hasComposerContent = draft.trim().length > 0 || files.length > 0;
      if (!sending && hasComposerContent && selectedCustomerId) {
        void sendMessage(event);
      }
    }
  };

  const formatStamp = (value) => formatMarketplaceDateTime(value);

  const initials =
    (customer?.customerName || selectedContact?.customerName || "Customer")
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "CU";

  if (loading) {
    return <div className="loading-region messages-loading-region"><Loader /></div>;
  }

  if (!contacts.length) {
    return (
      <div className="empty-workspace compact">
        <span>
          <Users size={22} />
        </span>
        <h2>No customer conversations yet</h2>
        <p>
          New customer messages will appear here as soon as they start a
          conversation.
        </p>
      </div>
    );
  }

  return (
    <section
      className={`messages-workspace${selectedCustomerId ? " has-selected-chat" : ""}`}
    >
      <aside className="messages-contacts">
        <div className="messages-toolbar">
          <label className="messages-search">
            <Search size={15} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search customers"
            />
          </label>
        </div>
        <div className="messages-contact-list">
          {filteredContacts.length ? (
            filteredContacts.map((contact) => {
              const active = String(contact._id) === String(selectedCustomerId);
              return (
                <button
                  key={contact._id}
                  type="button"
                  className={
                    active ? "messages-contact active" : "messages-contact"
                  }
                  onClick={() => setSelectedCustomerId(String(contact._id))}
                >
                  <span className="messages-avatar">
                    {contact.avatar ||
                      (contact.customerName || "CU")
                        .split(" ")
                        .filter(Boolean)
                        .slice(0, 2)
                        .map((part) => part[0])
                        .join("")
                        .toUpperCase() ||
                      "CU"}
                  </span>
                  <span className="messages-contact-copy">
                    <strong>{contact.customerName}</strong>
                    <small>{contact.lastMessage || "No messages yet"}</small>
                  </span>
                  <span className="messages-meta">
                    <time>{formatStamp(contact.lastMessageAt)}</time>
                    {contact.unreadCount ? <b>{contact.unreadCount}</b> : null}
                  </span>
                </button>
              );
            })
          ) : (
            <div className="messages-empty">
              No conversations match your search.
            </div>
          )}
        </div>
      </aside>
      <div className="messages-chat">
        {selectedContact ? (
          <>
            <div className="messages-header">
              <span className="messages-avatar large">
                {selectedContact.avatar || initials}
              </span>
              <div>
                <strong>{selectedContact.customerName}</strong>
                <small>
                  {selectedContact.emailAddress || "Customer conversation"}
                  {selectedContact.phoneNumber ? (
                    <span
                      style={{ display: "inline-block", minWidth: "1.5rem" }}
                    />
                  ) : null}
                  {selectedContact.phoneNumber
                    ? `  ${selectedContact.phoneNumber}`
                    : ""}
                </small>
              </div>
              <button
                type="button"
                className="messages-close-chat"
                onClick={() => setSelectedCustomerId("")}
                aria-label="Close chat"
                title="Close chat"
              >
                <X className="messages-close-chat-icon" size={16} />
                <ChevronLeft className="messages-back-chat-icon" size={17} />
                <span className="messages-back-chat-label">Back</span>
              </button>
            </div>
            <div ref={threadRef} className="messages-thread" onScroll={handleThreadScroll}>
              {messages.length ? (
                messages.map((message) => {
                  const isOutgoing = message.sender === "admin";
                  const isRead = isOutgoing && message.status === "read";
                  const hasAudioAttachment = (message.attachments || []).some(
                    (attachment) =>
                      attachment?.kind === "audio" ||
                      attachment?.mimeType?.startsWith("audio/") ||
                      /\.(mp3|wav|ogg|m4a|webm)$/i.test(
                        attachment?.fileName || "",
                      ),
                  );
                  const currentPlaybackRate =
                    voicePlaybackRates[message._id] ?? 1;
                  const isEditingThis = editingMessageId === message._id;
                  const isActionVisible =
                    activeMessageActions === message._id && isOutgoing;
                  return (
                    <div
                      key={message._id}
                      className={`message-row ${isOutgoing ? "outgoing" : ""}`}
                    >
                      <div
                        className={`message-bubble ${hasAudioAttachment ? "voice-message" : ""}`}
                        onClick={
                          isOutgoing
                            ? () =>
                              setActiveMessageActions((current) =>
                                current === message._id ? "" : message._id,
                              )
                            : undefined
                        }
                      >
                        {isActionVisible && !isEditingThis && (
                          <div className="message-inline-actions">
                            <button
                              type="button"
                              className="message-inline-action"
                              onClick={(event) => {
                                event.stopPropagation();
                                beginEditingMessage(message);
                              }}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="message-inline-action danger"
                              onClick={(event) => {
                                event.stopPropagation();
                                deleteMessage(message._id);
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        )}
                        {isEditingThis ? (
                          <div className="message-edit-box">
                            <textarea
                              value={editDraft}
                              onChange={(event) =>
                                setEditDraft(event.target.value)
                              }
                              rows={3}
                              aria-label="Edit message"
                            />
                            <div className="message-edit-actions">
                              <button
                                type="button"
                                className="message-inline-action"
                                onClick={() => saveEditedMessage(message._id)}
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                className="message-inline-action quiet"
                                onClick={() => {
                                  setEditingMessageId(null);
                                  setEditDraft("");
                                }}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="message-meta">
                              <strong>
                                {isOutgoing
                                  ? "You"
                                  : selectedContact.customerName}
                              </strong>
                              <time>{formatStamp(message.createdAt)}</time>
                            </div>
                            {message.text && <p>{message.text}</p>}
                            {message.attachments?.length ? (
                              <div className="message-attachments">
                                {message.attachments.map(
                                  (attachment, index) => {
                                    if (attachment.kind === "product") {
                                      return <ProductContextCard key={`${message._id}-${index}`} attachment={attachment} />;
                                    }
                                    const isAudioAttachment =
                                      attachment?.kind === "audio" ||
                                      attachment?.mimeType?.startsWith(
                                        "audio/",
                                      ) ||
                                      /\.(mp3|wav|ogg|m4a|webm)$/i.test(
                                        attachment?.fileName || "",
                                      );
                                    if (isAudioAttachment) {
                                      const audioKey = `${message._id}-${index}`;
                                      const voiceState =
                                        voiceStates[audioKey] || {};
                                      const totalDuration = Number.isFinite(
                                        voiceState.duration,
                                      )
                                        ? voiceState.duration
                                        : 0;
                                      const playbackProgress =
                                        totalDuration > 0
                                          ? Number.isFinite(
                                            voiceState.currentTime,
                                          )
                                            ? (voiceState.currentTime /
                                              totalDuration) *
                                            100
                                            : 0
                                          : 0;
                                      const toggleVoicePlayback = async () => {
                                        const audio =
                                          audioRefs.current[audioKey];
                                        if (!audio) return;
                                        if (audio.paused) {
                                          try {
                                            await audio.play();
                                          } catch {
                                            setVoiceStates((current) => ({
                                              ...current,
                                              [audioKey]: {
                                                ...current[audioKey],
                                                isPlaying: false,
                                              },
                                            }));
                                          }
                                        } else {
                                          audio.pause();
                                        }
                                      };
                                      return (
                                        <div
                                          key={audioKey}
                                          className="message-audio-host"
                                        >
                                          <div className="voice-note-card">
                                            <button
                                              type="button"
                                              className={`voice-note-play ${voiceState.isPlaying ? "playing" : ""}`}
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                void toggleVoicePlayback();
                                              }}
                                              aria-label={
                                                voiceState.isPlaying
                                                  ? "Pause voice note"
                                                  : "Play voice note"
                                              }
                                            >
                                              {voiceState.isPlaying ? (
                                                <span
                                                  className="voice-note-pause-icon"
                                                  aria-hidden="true"
                                                />
                                              ) : (
                                                <span
                                                  className="voice-note-play-icon"
                                                  aria-hidden="true"
                                                />
                                              )}
                                            </button>
                                            <div className="voice-note-body">
                                              <div className="voice-note-head">
                                                <span className="voice-note-time">
                                                  {formatVoiceDuration(
                                                    voiceState.currentTime || 0,
                                                  )}
                                                </span>
                                                <span className="voice-note-duration">
                                                  {formatVoiceDuration(
                                                    totalDuration,
                                                  )}
                                                </span>
                                              </div>
                                              <div className="voice-note-waveform-row">
                                                <div
                                                  className="voice-note-waveform"
                                                  aria-label="Voice waveform"
                                                >
                                                  <div
                                                    className="voice-note-waveform-progress"
                                                    style={{
                                                      width: `${Math.min(Math.max(playbackProgress, 0), 100)}%`,
                                                    }}
                                                  />
                                                  {voiceWaveformBars.map(
                                                    (
                                                      barHeight,
                                                      waveformIndex,
                                                    ) => (
                                                      <span
                                                        key={`${audioKey}-${waveformIndex}`}
                                                        className="voice-note-bar"
                                                        style={{
                                                          height: `${Math.max(10, barHeight * 100)}%`,
                                                          opacity:
                                                            waveformIndex /
                                                              voiceWaveformBars.length <=
                                                              playbackProgress /
                                                              100
                                                              ? 1
                                                              : 0.38,
                                                        }}
                                                      />
                                                    ),
                                                  )}
                                                </div>
                                                <button
                                                  type="button"
                                                  className="message-speed-toggle"
                                                  onClick={(event) => {
                                                    event.stopPropagation();
                                                    cycleVoicePlaybackRate(
                                                      message._id,
                                                    );
                                                  }}
                                                >
                                                  {getVoicePlaybackLabel(
                                                    currentPlaybackRate,
                                                  )}
                                                </button>
                                              </div>
                                            </div>
                                          </div>
                                          <audio
                                            ref={(node) => {
                                              if (node) {
                                                audioRefs.current[audioKey] =
                                                  node;
                                                node.playbackRate =
                                                  currentPlaybackRate;
                                              }
                                            }}
                                            className="message-audio"
                                            src={`${API_ORIGIN}${attachment.url}`}
                                            preload="metadata"
                                            onLoadedMetadata={(event) => {
                                              const nextAudio =
                                                event.currentTarget;
                                              const nextDuration =
                                                Number.isFinite(
                                                  nextAudio.duration,
                                                )
                                                  ? nextAudio.duration
                                                  : 0;
                                              setVoiceStates((current) => ({
                                                ...current,
                                                [audioKey]: {
                                                  ...(current[audioKey] || {}),
                                                  duration: nextDuration,
                                                  currentTime:
                                                    nextAudio.currentTime || 0,
                                                },
                                              }));
                                              nextAudio.playbackRate =
                                                currentPlaybackRate;
                                            }}
                                            onTimeUpdate={(event) => {
                                              const nextAudio =
                                                event.currentTarget;
                                              setVoiceStates((current) => ({
                                                ...current,
                                                [audioKey]: {
                                                  ...(current[audioKey] || {}),
                                                  currentTime:
                                                    nextAudio.currentTime || 0,
                                                },
                                              }));
                                            }}
                                            onPlay={() =>
                                              setVoiceStates((current) => ({
                                                ...current,
                                                [audioKey]: {
                                                  ...(current[audioKey] || {}),
                                                  isPlaying: true,
                                                },
                                              }))
                                            }
                                            onPause={() =>
                                              setVoiceStates((current) => ({
                                                ...current,
                                                [audioKey]: {
                                                  ...(current[audioKey] || {}),
                                                  isPlaying: false,
                                                },
                                              }))
                                            }
                                            onEnded={() =>
                                              setVoiceStates((current) => ({
                                                ...current,
                                                [audioKey]: {
                                                  ...(current[audioKey] || {}),
                                                  isPlaying: false,
                                                  currentTime: 0,
                                                },
                                              }))
                                            }
                                          />
                                        </div>
                                      );
                                    }
                                    const isImageAttachment =
                                      attachment?.kind === "image" ||
                                      attachment?.mimeType?.startsWith("image/") ||
                                      /\.(avif|gif|jpe?g|png|webp)$/i.test(
                                        attachment?.fileName || "",
                                      );
                                    if (isImageAttachment) {
                                      return (
                                        <ImageAttachment
                                          key={`${message._id}-${index}`}
                                          attachment={attachment}
                                        />
                                      );
                                    }
                                    return (
                                      <AttachmentFileCard
                                        key={`${message._id}-${index}`}
                                        attachment={attachment}
                                      />
                                    );
                                  },
                                )}
                              </div>
                            ) : null}
                            {isOutgoing ? (
                              <span
                                className={`message-status-check outgoing ${isRead ? "read" : ""}`}
                                aria-label="Message status"
                              >
                                ✓✓
                              </span>
                            ) : null}
                          </>
                        )}{" "}
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="messages-empty">
                  Start the conversation with this customer.
                </div>
              )}
            </div>
            <form className="messages-composer" onSubmit={sendMessage}>
              <div className="messages-attachment-preview">
                {files.map((file, index) => (
                  <span
                    key={`${file.name}-${index}`}
                    className="attachment-chip"
                  >
                    <span>{file.name}</span>
                    <button
                      type="button"
                      className="attachment-remove"
                      onClick={() =>
                        setFiles((current) =>
                          current.filter((_, itemIndex) => itemIndex !== index),
                        )
                      }
                      aria-label={`Remove ${file.name}`}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
              {isRecording && (
                <div className="messages-recording-bar">
                  <span className="messages-recording-indicator" />
                  <span>
                    Recording {formatRecordingDuration(recordingSeconds)}
                  </span>
                  <button
                    type="button"
                    className="messages-recording-stop"
                    onClick={stopVoiceRecording}
                  >
                    Stop
                  </button>
                </div>
              )}
              <div className="messages-composer-row">
                <label className="messages-upload" aria-label="Attach file">
                  <Paperclip size={15} />
                  <input
                    type="file"
                    multiple
                    onChange={(event) => {
                      const nextFiles = Array.from(event.target.files || []);
                      setFiles((current) => [...current, ...nextFiles]);
                      event.target.value = "";
                    }}
                  />
                </label>
                <textarea
                  value={draft}
                  rows={1}
                  onChange={(event) => setDraft(event.target.value)}
                  onInput={(event) => {
                    const target = event.target;
                    target.style.height = "36px";
                    target.style.overflowY = "auto";
                  }}
                  onKeyDown={handleComposerKeyDown}
                  placeholder="Write a message..."
                  aria-label="Message"
                />
                <button
                  type="button"
                  className={`messages-mic-button ${isRecording ? "recording" : ""}`}
                  onClick={startVoiceRecording}
                  aria-label={
                    isRecording ? "Stop recording" : "Record voice message"
                  }
                  disabled={sending}
                >
                  {isRecording ? <MicOff size={15} /> : <Mic size={15} />}
                </button>
                <button
                  type="submit"
                  className="messages-send-button"
                  disabled={
                    sending ||
                    (!draft.trim() && !files.length) ||
                    !selectedCustomerId
                  }
                  aria-label="Send message"
                >
                  <Send size={15} />
                </button>
              </div>
              {error && (
                <div className="form-error" role="alert">
                  {error}
                </div>
              )}
            </form>
          </>
        ) : (
          <div className="empty-workspace compact">
            <span>
              <MessageCircle size={22} />
            </span>
            <h2>Select a customer</h2>
            <p>
              Choose a conversation from the left to review messages and reply.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function EmptyWorkspace({ section }) {
  if (section === "Profile") return <ProfileWorkspace />;
  return (
    <div className="empty-workspace">
      <span>
        <Settings size={22} />
      </span>
      <h2>{section} workspace</h2>
      <p>This operational area is ready for the next connected workflow.</p>
    </div>
  );
}

function SettingsWorkspace() {
  const [employee, setEmployee] = useState(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`${API_URL}/auth/profile`, { headers: authHeaders(), cache: "no-store" })
      .then(parseResponse)
      .then((result) => setEmployee(result.employee))
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    setNotice("");
    setError("");
    if (!newPassword || !confirmPassword) {
      setError("Enter and confirm your new password.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch(`${API_URL}/auth/change-password`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ password: newPassword, confirmPassword }),
      });
      const result = await parseResponse(response);
      setNewPassword("");
      setConfirmPassword("");
      setNotice(result.message || "Password updated successfully.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="loading-region"><Loader /></div>;
  if (!employee) return <div className="dashboard-notice" role="alert">{error || "Unable to load your profile."}</div>;

  const profileFields = [
    ["Name", employee.fullName],
    ["Father Name", employee.fatherName],
    ["Email", employee.emailAddress],
    ["Phone Number", employee.phoneNumber],
    ["Role", employee.designation],
    ["CNIC", employee.cnic],
    ["Address", employee.address],
    ["Status", employee.status],
  ].filter(([, value]) => value !== undefined && value !== null && String(value).trim());

  return (
    <section className="settings-workspace">
      <section className="settings-section data-panel">
        <div className="panel-heading">
          <div><h2>Profile</h2><p>Account information for the currently signed-in employee.</p></div>
        </div>
        <div className="settings-profile-grid">
          {profileFields.map(([label, value]) => (
            <label key={label}>{label}<input value={value} readOnly /></label>
          ))}
        </div>
      </section>
      <form className="settings-section data-panel" onSubmit={submit} noValidate>
        <div className="panel-heading">
          <div><h2>Change Password</h2><p>Choose a new password for your account.</p></div>
        </div>
        <div className="settings-password-fields">
          <label>New Password<PasswordField name="newPassword" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="Enter a new password" autoComplete="new-password" /></label>
          <label>Confirm Password<PasswordField name="confirmPassword" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Confirm your new password" autoComplete="new-password" /></label>
        </div>
        {error && <div className="form-error" role="alert">{error}</div>}
        {notice && <div className="dashboard-notice" role="status"><CheckCircle2 size={16} /> {notice}</div>}
        <button className="button primary" type="submit" disabled={submitting}>{submitting ? <Loader /> : "Change Password"} <ArrowRight size={16} /></button>
      </form>
    </section>
  );
}

function ContactModal({ onClose }) {
  const [form, setForm] = useState({
    firstName: "",
    phoneNumber: "",
    email: "",
    message: "",
  });
  const [errors, setErrors] = useState({});
  const [status, setStatus] = useState("idle");
  const [serverError, setServerError] = useState("");
  const validate = () => {
    const nextErrors = {};
    if (!form.firstName.trim())
      nextErrors.firstName = "First name is required.";
    if (!form.phoneNumber.trim())
      nextErrors.phoneNumber = "Phone number is required.";
    else if (!/^\+?[\d\s().-]{7,20}$/.test(form.phoneNumber))
      nextErrors.phoneNumber = "Enter a valid phone number.";
    if (!form.email.trim()) nextErrors.email = "Email is required.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email))
      nextErrors.email = "Enter a valid email address.";
    if (!form.message.trim()) nextErrors.message = "Message is required.";
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };
  const submit = async (event) => {
    event.preventDefault();
    setServerError("");
    if (!validate()) return;
    setStatus("submitting");
    try {
      const response = await fetch(`${API_URL}/inquiries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.message || "Unable to send your message.");
      setStatus("success");
    } catch (error) {
      setServerError(error.message);
      setStatus("idle");
    }
  };
  const update = (field, value) => {
    setForm({ ...form, [field]: value });
    if (errors[field]) setErrors({ ...errors, [field]: "" });
  };
  if (status === "success")
    return (
      <div
        className="contact-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="contact-title"
      >
        <div className="contact-modal success-modal">
          <button
            className="modal-close"
            onClick={onClose}
            aria-label="Close contact form"
          >
            <X size={18} />
          </button>
          <span className="success-mark">
            <Check size={22} />
          </span>
          <h2 id="contact-title">Thanks!</h2>
          <p>Our team will get back to you shortly.</p>
          <button className="button primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  return (
    <div
      className="contact-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="contact-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form className="contact-modal" onSubmit={submit} noValidate>
        <div className="modal-heading">
          <div>
            <div className="eyebrow">READY WHEN YOU ARE</div>
            <h2 id="contact-title">Talk to our team.</h2>
            <p>Share a few details and we will be in touch.</p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close contact form"
          >
            <X size={18} />
          </button>
        </div>
        <div className="contact-form-grid">
          <label>
            First Name
            <input
              value={form.firstName}
              onChange={(event) => update("firstName", event.target.value)}
              placeholder="Enter your first name"
              aria-invalid={!!errors.firstName}
            />
            {errors.firstName && (
              <small className="field-error">{errors.firstName}</small>
            )}
          </label>
          <label>
            Phone Number
            <input
              value={form.phoneNumber}
              onChange={(event) => update("phoneNumber", event.target.value)}
              placeholder="Enter your phone number"
              inputMode="tel"
              aria-invalid={!!errors.phoneNumber}
            />
            {errors.phoneNumber && (
              <small className="field-error">{errors.phoneNumber}</small>
            )}
          </label>
          <label>
            Email
            <input
              value={form.email}
              onChange={(event) => update("email", event.target.value)}
              placeholder="Enter your email address"
              type="email"
              aria-invalid={!!errors.email}
            />
            {errors.email && (
              <small className="field-error">{errors.email}</small>
            )}
          </label>
          <label className="message-field">
            Message
            <textarea
              value={form.message}
              onChange={(event) => update("message", event.target.value)}
              placeholder="Write your message..."
              rows="4"
              aria-invalid={!!errors.message}
            />
            {errors.message && (
              <small className="field-error">{errors.message}</small>
            )}
          </label>
        </div>
        {serverError && (
          <div className="form-error" role="alert">
            {serverError}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="button quiet" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={status === "submitting"}
          >
            {status === "submitting" ? <Loader /> : "Send message"}{" "}
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}

function ContactForm() {
  const [form, setForm] = useState({
    firstName: "",
    phoneNumber: "",
    email: "",
    message: "",
  });
  const [errors, setErrors] = useState({});
  const [status, setStatus] = useState("idle");
  const [serverError, setServerError] = useState("");
  const update = (field, value) => {
    setForm({ ...form, [field]: value });
    if (errors[field]) setErrors({ ...errors, [field]: "" });
  };
  const validate = () => {
    const nextErrors = {};
    if (!form.firstName.trim())
      nextErrors.firstName = "First name is required.";
    if (!form.phoneNumber.trim())
      nextErrors.phoneNumber = "Phone number is required.";
    else if (!/^\+?[\d\s().-]{7,20}$/.test(form.phoneNumber))
      nextErrors.phoneNumber = "Enter a valid phone number.";
    if (!form.email.trim()) nextErrors.email = "Email is required.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email))
      nextErrors.email = "Enter a valid email address.";
    if (!form.message.trim()) nextErrors.message = "Message is required.";
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };
  const submit = async (event) => {
    event.preventDefault();
    setServerError("");
    if (!validate()) return;
    setStatus("submitting");
    try {
      const response = await fetch(`${API_URL}/contact-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.message || "Unable to send your message.");
      setStatus("success");
    } catch (error) {
      setServerError(error.message);
      setStatus("idle");
    }
  };
  if (status === "success")
    return (
      <div className="contact-form-success" role="status">
        <span className="success-mark">
          <Check size={18} />
        </span>
        <div>
          <strong>Thanks!</strong>
          <p>Our team will get back to you shortly.</p>
        </div>
      </div>
    );
  return (
    <form className="contact-form" onSubmit={submit} noValidate>
      <div className="contact-form-grid">
        <label>
          First Name
          <input
            value={form.firstName}
            onChange={(event) => update("firstName", event.target.value)}
            placeholder="Enter your first name"
            aria-invalid={!!errors.firstName}
          />
          {errors.firstName && (
            <small className="field-error">{errors.firstName}</small>
          )}
        </label>
        <label>
          Phone Number
          <input
            value={form.phoneNumber}
            onChange={(event) => update("phoneNumber", event.target.value)}
            placeholder="Enter your phone number"
            inputMode="tel"
            aria-invalid={!!errors.phoneNumber}
          />
          {errors.phoneNumber && (
            <small className="field-error">{errors.phoneNumber}</small>
          )}
        </label>
        <label>
          Email
          <input
            value={form.email}
            onChange={(event) => update("email", event.target.value)}
            placeholder="Enter your email address"
            type="email"
            aria-invalid={!!errors.email}
          />
          {errors.email && (
            <small className="field-error">{errors.email}</small>
          )}
        </label>
        <label className="message-field">
          Message
          <textarea
            value={form.message}
            onChange={(event) => update("message", event.target.value)}
            placeholder="Write your message..."
            rows="3"
            aria-invalid={!!errors.message}
          />
          {errors.message && (
            <small className="field-error">{errors.message}</small>
          )}
        </label>
      </div>
      {serverError && (
        <div className="form-error" role="alert">
          {serverError}
        </div>
      )}
      <button
        className="button dark contact-submit"
        type="submit"
        disabled={status === "submitting"}
      >
        {status === "submitting" ? <Loader /> : "Send message"}{" "}
        <ArrowRight size={16} />
      </button>
    </form>
  );
}

function App() {
  const [route, setRoute] = useState(() => window.location.pathname);
  const isDashboard = route.startsWith("/dashboard");
  const [auth, setAuth] = useState(isDashboard ? null : { public: true });
  const [filter, setFilter] = useState("All products");
  const [query, setQuery] = useState("");
  const [dashboard, setDashboard] = useState(false);
  const [toast, setToast] = useState("");
  const [marketProducts, setMarketProducts] = useState([]);
  const [marketCategories, setMarketCategories] = useState([]);
  const [marketLoading, setMarketLoading] = useState(true);
  const marketRecoveryTimerRef = useRef(null);
  const marketRecoveryAttemptRef = useRef(0);
  const marketRequestIdRef = useRef(0);
  const marketPageRequestIdRef = useRef(0);
  const marketPaginationInFlightRef = useRef(false);
  useEffect(() => {
    if (
      route === "/products" ||
      /^\/products\/[^/]+/.test(route) ||
      route === "/community" ||
      /^\/community\/[^/]+/.test(route) ||
      route === "/categories" ||
      /^\/categories\/[^/]+/.test(route) ||
      route === "/about" ||
      /^\/about(?:\/|$)/.test(route) ||
      route === "/cbm-calculator"
    )
      window.scrollTo(0, 0);
  }, [route]);
  useEffect(() => {
    const syncRoute = () => setRoute(window.location.pathname);
    const navigate = (event) => {
      const anchor = event.target.closest?.("a[href]");
      if (
        !anchor ||
        event.defaultPrevented ||
        anchor.target === "_blank" ||
        anchor.origin !== window.location.origin
      )
        return;
      const url = new URL(anchor.href);
      if (
        !["/", "/products", "/categories", "/community", "/about", "/cbm-calculator"].some(
          (prefix) =>
            url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
        )
      )
        return;
      if (url.hash && url.pathname === window.location.pathname) return;
      event.preventDefault();
      window.history.pushState(
        {},
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
      setRoute(url.pathname);
    };
    window.addEventListener("popstate", syncRoute);
    document.addEventListener("click", navigate);
    return () => {
      window.removeEventListener("popstate", syncRoute);
      document.removeEventListener("click", navigate);
    };
  }, []);
  useEffect(() => {
    if (!isDashboard) return undefined;
    if (!authToken()) {
      setAuth(false);
      return undefined;
    }
    const response = fetchWithRecovery(`${API_URL}/auth/me`, { headers: authHeaders() })
      .then(parseResponse)
      .then((result) => {
        localStorage.setItem(
          "omni-dashboard-user",
          JSON.stringify(result.employee),
        );
        setAuth(result.employee);
      })
      .catch(() => {
        localStorage.removeItem("omni-dashboard-token");
        localStorage.removeItem("omni-dashboard-user");
        setAuth(false);
      });
    return () => {
      void response;
    };
  }, [isDashboard]);
  useEffect(() => {
    if (!isDashboard || !auth || auth.public) return undefined;
    const link = document.querySelector(".sidebar-back");
    if (!link) return undefined;
    link.dataset.userName = auth.fullName || "User";
    const handleLogout = (event) => {
      event.preventDefault();
      logout();
    };
    link.addEventListener("click", handleLogout);
    return () => link.removeEventListener("click", handleLogout);
  }, [isDashboard, auth]);
  useEffect(() => {
    if (route === "/") {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      if (new URLSearchParams(window.location.search).get("contact") === "1") {
        requestAnimationFrame(() => {
          const section = document.getElementById("contact");
          if (!section) return;
          const top = section.getBoundingClientRect().top + window.scrollY - 74;
          window.scrollTo({ top, left: 0, behavior: "smooth" });
        });
      }
    }
  }, [route]);
  const [marketPage, setMarketPage] = useState(1);
  const [marketHasMore, setMarketHasMore] = useState(false);
  const [marketLoadingMore, setMarketLoadingMore] = useState(false);
  const [marketSentinel, setMarketSentinel] = useState(null);
  const loadMarketplacePage = async (nextPage = 1, append = false, requestId = marketRequestIdRef.current) => {
    const pageRequestId = ++marketPageRequestIdRef.current;
    const productResult = await getJson(`/products?sort=hot-selling&limit=12&page=${nextPage}`);
    if (requestId !== marketRequestIdRef.current || pageRequestId !== marketPageRequestIdRef.current)
      return productResult;
    const nextProducts = productResult.data || [];
    setMarketProducts((current) => append ? [...current, ...nextProducts] : nextProducts);
    setMarketPage(productResult.page || nextPage);
    setMarketHasMore(Boolean(productResult.pages && productResult.page < productResult.pages));
    return productResult;
  };
  const scheduleMarketplaceRecovery = () => {
    if (marketRecoveryTimerRef.current) return;
    const attempt = marketRecoveryAttemptRef.current;
    const delay = [3000, 7000, 15000, 30000][Math.min(attempt, 3)];
    marketRecoveryAttemptRef.current = Math.min(attempt + 1, 4);
    console.warn(`[marketplace] recovery_retry attempt=${attempt + 1} delayMs=${delay}`);
    marketRecoveryTimerRef.current = window.setTimeout(() => {
      marketRecoveryTimerRef.current = null;
      void loadMarketplace();
    }, delay);
  };
  const loadMarketplace = async () => {
    const requestId = ++marketRequestIdRef.current;
    marketPageRequestIdRef.current += 1;
    marketPaginationInFlightRef.current = false;
    setMarketLoading(true);
    setMarketLoadingMore(false);
    setMarketHasMore(false);
    const [productResult, categoryResult] = await Promise.allSettled([
      loadMarketplacePage(1, false, requestId),
      getJson("/categories?page=1&limit=100", 30000),
    ]);
    if (requestId !== marketRequestIdRef.current) return;
    let failed = false;
    if (productResult.status === "fulfilled") {
      setMarketHasMore(Boolean(productResult.value.pages && productResult.value.page < productResult.value.pages));
    } else {
      failed = true;
    }
    if (categoryResult.status === "fulfilled") {
      setMarketCategories(categoryResult.value.data || []);
    } else {
      failed = true;
    }
    if (failed) scheduleMarketplaceRecovery();
    else marketRecoveryAttemptRef.current = 0;
    setMarketLoading(false);
  };
  useEffect(() => {
    if (isDashboard || route !== "/") return undefined;
    void loadMarketplace();
    const refresh = () => {
      void loadMarketplace();
    };
    const onStorage = (event) => {
      if (event.key === catalogChangeKey) refresh();
    };
    window.addEventListener("storage", onStorage);
    catalogSyncChannel?.addEventListener("message", refresh);
    return () => {
      marketRequestIdRef.current += 1;
      marketPageRequestIdRef.current += 1;
      marketPaginationInFlightRef.current = false;
      window.removeEventListener("storage", onStorage);
      catalogSyncChannel?.removeEventListener("message", refresh);
      if (marketRecoveryTimerRef.current) {
        window.clearTimeout(marketRecoveryTimerRef.current);
        marketRecoveryTimerRef.current = null;
      }
    };
  }, [isDashboard, route]);
  useEffect(() => {
    if (!marketSentinel || !marketHasMore || marketLoadingMore) return undefined;
    const requestId = marketRequestIdRef.current;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && requestId === marketRequestIdRef.current && !marketPaginationInFlightRef.current) {
        marketPaginationInFlightRef.current = true;
        setMarketLoadingMore(true);
        loadMarketplacePage(marketPage + 1, true, requestId)
          .catch(() => {
            if (requestId === marketRequestIdRef.current) {
              setMarketHasMore(false);
              scheduleMarketplaceRecovery();
            }
          })
          .finally(() => {
            if (requestId === marketRequestIdRef.current) {
              marketPaginationInFlightRef.current = false;
              setMarketLoadingMore(false);
            }
          });
      }
    }, { rootMargin: "180px" });
    observer.observe(marketSentinel);
    return () => observer.disconnect();
  }, [marketSentinel, marketPage, marketHasMore, marketLoadingMore]);
  const filtered = marketProducts.filter(
    (product) =>
      (filter === "All products" || product.category === filter) &&
      product.name.toLowerCase().includes(query.toLowerCase()),
  );
  const notify = (message) => {
    setToast(message);
    setTimeout(() => setToast(""), 3000);
  };
  if (isDashboard && auth === null)
    return (
      <main className="login-page">
        <div className="loading-region"><Loader /></div>
      </main>
    );
  if (isDashboard && !auth)
    return <LoginPage onLogin={() => window.location.replace("/dashboard")} />;
  if (route === "/about")
    return (
      <>
        <ShoppingChat />
        <Header
          onDashboard={() => {
            window.location.href = "/dashboard";
          }}
        />
        <AboutPage />
        <GlobalFooter />
      </>
    );
  if (route === "/cbm-calculator")
    return (
      <>
        <ShoppingChat />
        <Header
          onDashboard={() => {
            window.location.href = "/dashboard";
          }}
        />
        <CBMCalculatorPage />
        <GlobalFooter />
      </>
    );
  if (route === "/community" || route.startsWith("/community/")) {
    const communityPostId = route.match(/^\/community\/([^/]+)/)?.[1] || "";
    return (
      <>
        <ShoppingChat />
        <Header
          onDashboard={() => {
            window.location.href = "/dashboard";
          }}
        />
        <CommunityPage
          apiUrl={API_URL}
          mediaUrl={mediaUrl}
          fetchWithRecovery={fetchWithRecovery}
          parseResponse={parseResponse}
          postId={communityPostId ? decodeURIComponent(communityPostId) : ""}
        />
        <GlobalFooter />
      </>
    );
  }
  if (route === "/products")
    return (
      <>
        <ShoppingChat />
        <ProductsPage />
      </>
    );
  const productMatch = route.match(/^\/products\/([^/]+)/);
  if (productMatch)
    return (
      <>
        <ShoppingChat />
        <div className="product-detail-shell">
          <ProductDetail productId={productMatch[1]} />
          <GlobalFooter />
        </div>
      </>
    );
  const categoryMatch = route.match(/^\/categories(?:\/([^/]+))?$/);
  if (categoryMatch)
    return (
      <>
        <ShoppingChat />
        <CategoriesPage selectedSlug={categoryMatch[1]} />
      </>
    );
  const dashboardMatch = route.match(/^\/dashboard(?:\/([^/]+))?\/?$/);
  if (dashboardMatch) {
    const sectionKey = dashboardMatch[1];
    if (sectionKey && !dashboardSections[sectionKey])
      return (
        <div className="empty-workspace">
          <h2>Dashboard page not found</h2>
          <p>Choose a section from the dashboard navigation.</p>
        </div>
      );
    return (
      <DashboardWorkspace
        initialSection={dashboardSectionFromPath(window.location.pathname)}
      />
    );
  }
  if (route.startsWith("/dashboard")) return <DashboardWorkspace />;
  return (
    <>
      <ShoppingChat />
      <Header
        onDashboard={() => {
          window.location.href = "/dashboard";
        }}
      />
      <main>
        <Hero
          onBrowse={() => navigateTo("/products")}
        />
        <TrustStrip />
        <CategoryMarquee
          items={marketCategories}
          loading={marketLoading}
          onCategory={(category) => {
            setFilter(category);
            document
              .getElementById("products")
              .scrollIntoView({ behavior: "smooth" });
          }}
        />
        <section className="discover section" id="products">
          <div className="section-heading">
            <div>
              <h2>Discover Products That Stand Out</h2>
            </div>
            <a href="/products" className="text-link">
              View all products <ArrowRight size={16} />
            </a>
          </div>
          {marketLoading ? <div className="loading-region"><Loader /></div> : (
            <>
              <div className="product-grid">
                {filtered.map((product) => (
                  <ProductCard
                    key={product._id || product.name}
                    product={product}
                    onInquire={(item) => notify(`Inquiry started for ${item.name}`)}
                  />
                ))}
              </div>
              {marketLoadingMore && (
                <div className="loading-region"><Loader /></div>
              )}
              {!marketLoadingMore && marketHasMore && <div ref={setMarketSentinel} aria-hidden="true" style={{ height: 1 }} />}
              {filtered.length === 0 && !marketLoadingMore && (
                <div className="empty">
                  No matching products yet. Try a broader search.
                </div>
              )}
            </>
          )}
        </section>
        <section className="trust-band">
          <div>
            <div className="eyebrow light">BUILT FOR THE LONG RUN</div>
            <h2>Less noise. More useful trade.</h2>
            <p>
              Vendor Woo brings the details that make global sourcing feel
              straightforward.
            </p>
          </div>
          <div className="trust-items">
            <span>
              <ShieldCheck size={22} /> Verified partners
            </span>
            <span>
              <Globe2 size={22} /> Global reach
            </span>
            <span>
              <Truck size={22} /> Clear logistics
            </span>
          </div>
        </section>
        <section className="contact section" id="contact">
          <div className="contact-copy">
            <div className="eyebrow">READY WHEN YOU ARE</div>
            <h2>Have a product in mind?</h2>
            <p>
              Tell us what you are building and our sourcing team will help you
              find the right next step.
            </p>
          </div>
          <ContactForm />
        </section>
      </main>
      <GlobalFooter />
      {dashboard && (
        <div className="overlay" onClick={() => setDashboard(false)}>
          <div onClick={(event) => event.stopPropagation()}>
            <Dashboard onClose={() => setDashboard(false)} />
          </div>
        </div>
      )}
      {toast && (
        <div className="toast">
          <Check size={17} /> {toast}
        </div>
      )}
    </>
  );
}

function CBMCalculatorPage() {
  const [uom, setUom] = useState("cm");
  const [dimensions, setDimensions] = useState({
    length: 0,
    width: 0,
    height: 0,
  });
  const [weightPerCarton, setWeightPerCarton] = useState(0);
  const [weightUnit, setWeightUnit] = useState("kg");
  const [quantity, setQuantity] = useState(1);

  const updateDimension = (field, value) => {
    setDimensions((current) => ({ ...current, [field]: value }));
  };

  const quantityNumber = Number(quantity);
  const dimensionEntries = Object.entries(dimensions);
  const hasAnyDimension = dimensionEntries.some(([_, value]) => String(value).trim() !== "");
  const quantityValueValid = quantity !== "" && Number.isFinite(quantityNumber) && quantityNumber > 0 && Number.isInteger(quantityNumber);

  const dimensionErrors = {
    length: dimensions.length !== "" && (!Number.isFinite(Number(dimensions.length)) || Number(dimensions.length) < 0) ? "Enter a valid non-negative number." : "",
    width: dimensions.width !== "" && (!Number.isFinite(Number(dimensions.width)) || Number(dimensions.width) < 0) ? "Enter a valid non-negative number." : "",
    height: dimensions.height !== "" && (!Number.isFinite(Number(dimensions.height)) || Number(dimensions.height) < 0) ? "Enter a valid non-negative number." : "",
  };
  const weightError = weightPerCarton !== "" && (!Number.isFinite(Number(weightPerCarton)) || Number(weightPerCarton) < 0) ? "Enter a valid non-negative weight." : "";
  const quantityError = !quantityValueValid ? "Quantity must be a positive whole number." : "";
  const hasInvalidInput = Object.values(dimensionErrors).some(Boolean) || !!weightError || !!quantityError || (!hasAnyDimension && quantity === "");

  const results = calculateCbmMetrics({
    length: dimensions.length,
    width: dimensions.width,
    height: dimensions.height,
    unit: uom,
    weightPerCarton,
    weightUnit,
    quantity: quantityValueValid ? quantityNumber : 0,
    seaVolumetricFactorKgPerCbm: DEFAULT_SEA_VOLUMETRIC_FACTOR_KG_PER_CBM,
    airDimensionalDivisor: DEFAULT_AIR_DIMENSIONAL_DIVISOR,
  });

  const formatNumber = (value, maxFractionDigits = 3) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "0";
    return numeric.toLocaleString(undefined, {
      maximumFractionDigits: maxFractionDigits,
      minimumFractionDigits: 0,
    });
  };

  const resetCalculator = () => {
    setUom("cm");
    setDimensions({ length: 0, width: 0, height: 0 });
    setWeightPerCarton(0);
    setWeightUnit("kg");
    setQuantity("1");
  };

  return (
    <main className="cbm-calculator-page">
      <section className="section cbm-calculator-shell">
        <div className="section-heading cbm-header-row">
          <div className="cbm-heading-wrap category-page-heading">
            <h1 className="cbm-main-title">CBM Calculator</h1>
          </div>
        </div>

        <div className="cbm-layout">
          <div className="cbm-panel">
            <div className="cbm-panel-header">
              <h3>Shipment details</h3>
              <button type="button" className="button outline small-button" onClick={resetCalculator}>
                Reset
              </button>
            </div>

            <div className="cbm-input-grid">
              <div className="cbm-input-row cbm-input-row-four">
                <label className="cbm-field">
                  <span>Dimension Unit (UOM)</span>
                  <select value={uom} onChange={(event) => setUom(event.target.value)}>
                    <option value="cm">cm</option>
                    <option value="m">m</option>
                    <option value="mm">mm</option>
                    <option value="inch">inch</option>
                    <option value="ft">ft</option>
                  </select>
                </label>

                <label className="cbm-field">
                  <span>Length</span>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    inputMode="decimal"
                    value={dimensions.length}
                    onChange={(event) => updateDimension("length", event.target.value)}
                    aria-invalid={!!dimensionErrors.length}
                  />
                  {dimensionErrors.length && <small className="field-error">{dimensionErrors.length}</small>}
                </label>

                <label className="cbm-field">
                  <span>Width</span>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    inputMode="decimal"
                    value={dimensions.width}
                    onChange={(event) => updateDimension("width", event.target.value)}
                    aria-invalid={!!dimensionErrors.width}
                  />
                  {dimensionErrors.width && <small className="field-error">{dimensionErrors.width}</small>}
                </label>

                <label className="cbm-field">
                  <span>Height</span>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    inputMode="decimal"
                    value={dimensions.height}
                    onChange={(event) => updateDimension("height", event.target.value)}
                    aria-invalid={!!dimensionErrors.height}
                  />
                  {dimensionErrors.height && <small className="field-error">{dimensionErrors.height}</small>}
                </label>
              </div>

              <div className="cbm-input-row cbm-input-row-three">
                <label className="cbm-field">
                  <span>Weight per carton/package (Optional)</span>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    inputMode="decimal"
                    value={weightPerCarton}
                    onChange={(event) => setWeightPerCarton(event.target.value)}
                    aria-invalid={!!weightError}
                  />
                  {weightError && <small className="field-error">{weightError}</small>}
                </label>

                <label className="cbm-field">
                  <span>Weight unit</span>
                  <select value={weightUnit} onChange={(event) => setWeightUnit(event.target.value)}>
                    <option value="kg">kg</option>
                    <option value="lb">lb</option>
                  </select>
                </label>

                <label className="cbm-field">
                  <span>Quantity</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    inputMode="numeric"
                    value={quantity}
                    onChange={(event) => setQuantity(event.target.value)}
                    aria-invalid={!!quantityError}
                  />
                  {quantityError && <small className="field-error">{quantityError}</small>}
                </label>
              </div>
            </div>

            {hasInvalidInput && (
              <div className="cbm-input-note">
                Enter valid non-negative dimensions and a positive whole quantity to calculate shipment volume and weight.
              </div>
            )}
          </div>

          <div className="cbm-results" aria-live="polite">
            <div className="cbm-result-group">
              <h3>Volume</h3>
              <div className="cbm-stat-grid cbm-volume-grid">
                <div className="cbm-stat">
                  <span>CBM per Carton</span>
                  <strong>{formatNumber(results.cbmPerCarton, 6)} m³</strong>
                </div>
                <div className="cbm-stat">
                  <span>Total CBM</span>
                  <strong>{formatNumber(results.totalCbm, 6)} m³</strong>
                </div>
                <div className="cbm-stat">
                  <span>Cubic Feet</span>
                  <strong>{formatNumber(results.cubicFeet, 3)} ft³</strong>
                </div>
              </div>
            </div>

            <div className="cbm-result-group">
              <h3>Weight</h3>
              <div className="cbm-stat-grid cbm-weight-grid">
                <div className="cbm-stat">
                  <span>Actual Weight in Kilograms</span>
                  <strong>{formatNumber(results.actualWeightKg, 3)} kg</strong>
                </div>
                <div className="cbm-stat">
                  <span>Actual Weight in Pounds</span>
                  <strong>{formatNumber(results.actualWeightLb, 3)} lb</strong>
                </div>
              </div>
            </div>

            <div className="cbm-result-group">
              <h3>Volumetric Weight</h3>
              <div className="cbm-stat-grid cbm-volumetric-grid">
                <div className="cbm-stat">
                  <span>Sea Volumetric Weight in Kilograms</span>
                  <strong>{formatNumber(results.seaVolumetricWeightKg, 3)} kg</strong>
                </div>
                <div className="cbm-stat">
                  <span>Sea Volumetric Weight in Pounds</span>
                  <strong>{formatNumber(results.seaVolumetricWeightLb, 3)} lb</strong>
                </div>
                <div className="cbm-stat">
                  <span>Air Volumetric Weight in Kilograms</span>
                  <strong>{formatNumber(results.airVolumetricWeightKg, 3)} kg</strong>
                </div>
                <div className="cbm-stat">
                  <span>Air Volumetric Weight in Pounds</span>
                  <strong>{formatNumber(results.airVolumetricWeightLb, 3)} lb</strong>
                </div>
              </div>
            </div>

            <div className="cbm-result-group">
              <h3>Chargeable Air Weight</h3>
              <div className="cbm-stat-grid cbm-chargeable-grid">
                <div className="cbm-stat">
                  <span>Chargeable Air Weight in Kilograms</span>
                  <strong>{formatNumber(results.chargeableAirWeightKg, 3)} kg</strong>
                </div>
                <div className="cbm-stat">
                  <span>Chargeable Air Weight in Pounds</span>
                  <strong>{formatNumber(results.chargeableAirWeightLb, 3)} lb</strong>
                </div>
              </div>
            </div>

            <div className="cbm-result-group">
              <h3>Container Estimates</h3>
              <div className="cbm-estimates-list">
                <div><span>20FT</span><strong>{formatNumber(results.containerEstimates.twentyFt, 0)} cartons</strong></div>
                <div><span>40FT</span><strong>{formatNumber(results.containerEstimates.fortyFt, 0)} cartons</strong></div>
                <div><span>40FT HC</span><strong>{formatNumber(results.containerEstimates.fortyFtHighCube, 0)} cartons</strong></div>
              </div>
              <small className="cbm-footnote">
                Volume-based estimates only. Real loading depends on carton layout, palletization, orientation, and weight distribution.
              </small>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
