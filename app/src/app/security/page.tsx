"use client";

import { useState, useEffect } from "react";
import { 
  ShieldAlert, 
  ShieldCheck, 
  ShieldAlert as ShieldIcon, 
  Activity, 
  Clock, 
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Info
} from "lucide-react";
import { backendBaseUrl } from "../../lib/backend";

interface SecurityAlert {
  id: number;
  type: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  message: string;
  metadata: any;
  resolved: boolean;
  created_at: string;
}

interface SecurityStats {
  total: number;
  unresolved: number;
  bySeverity: Record<string, number>;
}

export default function SecurityDashboard() {
  const [alerts, setAlerts] = useState<SecurityAlert[]>([]);
  const [stats, setStats] = useState<SecurityStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, []);

  const fetchData = async () => {
    try {
      const baseUrl = backendBaseUrl();
      const [alertsRes, statsRes] = await Promise.all([
        fetch(`${baseUrl}/security/alerts`),
        fetch(`${baseUrl}/security/stats`)
      ]);
      
      const alertsData = await alertsRes.json();
      const statsData = await statsRes.json();
      
      setAlerts(alertsData);
      setStats(statsData);
    } catch (error) {
      console.error("Failed to fetch security data", error);
    } finally {
      setLoading(false);
    }
  };

  const resolveAlert = async (id: number) => {
    try {
      const baseUrl = backendBaseUrl();
      await fetch(`${baseUrl}/security/alerts/${id}/resolve`, { method: "POST" });
      fetchData();
    } catch (error) {
      console.error("Failed to resolve alert", error);
    }
  };

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "CRITICAL": return "bg-red-500/10 text-red-500 border-red-500/20";
      case "HIGH": return "bg-orange-500/10 text-orange-500 border-orange-500/20";
      case "MEDIUM": return "bg-yellow-500/10 text-yellow-500 border-yellow-500/20";
      case "LOW": return "bg-blue-500/10 text-blue-500 border-blue-500/20";
      default: return "bg-zinc-500/10 text-zinc-500 border-zinc-500/20";
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-8 pt-24 font-['Inter']">
      <div className="max-w-7xl mx-auto">
        <header className="mb-12 flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold mb-2 flex items-center gap-3">
              <ShieldIcon className="w-10 h-10 text-indigo-500" />
              Security Monitor
            </h1>
            <p className="text-zinc-400">Real-time automated security monitoring for NebGov contracts.</p>
          </div>
          <div className="flex gap-4">
            <div className="bg-zinc-900/50 border border-zinc-800 p-4 rounded-2xl flex items-center gap-4">
              <Activity className="w-6 h-6 text-emerald-500" />
              <div>
                <p className="text-xs text-zinc-500 uppercase tracking-wider">System Status</p>
                <p className="text-sm font-semibold text-emerald-500">Live & Scanning</p>
              </div>
            </div>
          </div>
        </header>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-12">
          <StatCard 
            title="Total Alerts" 
            value={stats?.total || 0} 
            icon={<Clock className="w-5 h-5" />}
            color="text-indigo-400"
          />
          <StatCard 
            title="Active Issues" 
            value={stats?.unresolved || 0} 
            icon={<AlertTriangle className="w-5 h-5" />}
            color="text-orange-400"
          />
          <StatCard 
            title="Critical" 
            value={stats?.bySeverity?.CRITICAL || 0} 
            icon={<ShieldAlert className="w-5 h-5" />}
            color="text-red-400"
          />
          <StatCard 
            title="Resolved" 
            value={(stats?.total || 0) - (stats?.unresolved || 0)} 
            icon={<ShieldCheck className="w-5 h-5" />}
            color="text-emerald-400"
          />
        </div>

        {/* Alerts Table */}
        <div className="bg-zinc-900/30 border border-zinc-800/50 rounded-3xl overflow-hidden backdrop-blur-sm">
          <div className="p-6 border-b border-zinc-800/50 flex items-center justify-between">
            <h2 className="text-xl font-bold flex items-center gap-2">
              Recent Alerts
              {alerts.filter(a => !a.resolved).length > 0 && (
                <span className="bg-red-500 text-white text-[10px] px-1.5 py-0.5 rounded-full animate-pulse">
                  {alerts.filter(a => !a.resolved).length}
                </span>
              )}
            </h2>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-zinc-900/50 text-zinc-400 text-xs uppercase tracking-widest">
                  <th className="px-6 py-4 font-semibold">Incident</th>
                  <th className="px-6 py-4 font-semibold">Severity</th>
                  <th className="px-6 py-4 font-semibold">Details</th>
                  <th className="px-6 py-4 font-semibold">Created</th>
                  <th className="px-6 py-4 font-semibold">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/30">
                {loading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td colSpan={5} className="px-6 py-8 h-20 bg-zinc-900/10"></td>
                    </tr>
                  ))
                ) : alerts.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-20 text-center text-zinc-500">
                      <ShieldCheck className="w-12 h-12 mx-auto mb-4 opacity-20" />
                      No security alerts found. The system is secure.
                    </td>
                  </tr>
                ) : (
                  alerts.map((alert) => (
                    <tr key={alert.id} className={`group hover:bg-zinc-800/20 transition-colors ${alert.resolved ? 'opacity-60' : ''}`}>
                      <td className="px-6 py-5">
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-xl border ${getSeverityColor(alert.severity)}`}>
                            {alert.type === 'LARGE_TRANSFER' ? <Activity className="w-4 h-4" /> : <ShieldAlert className="w-4 h-4" />}
                          </div>
                          <div>
                            <p className="font-semibold">{alert.type.replace('_', ' ')}</p>
                            <p className="text-xs text-zinc-500">ID: SG-{alert.id.toString().padStart(4, '0')}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-5">
                        <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${getSeverityColor(alert.severity)}`}>
                          {alert.severity}
                        </span>
                      </td>
                      <td className="px-6 py-5">
                        <p className="text-sm max-w-xs truncate" title={alert.message}>
                          {alert.message}
                        </p>
                        {alert.metadata?.proposal_id && (
                          <span className="text-[10px] text-indigo-400 mt-1 flex items-center gap-1">
                            <Info className="w-3 h-3" /> Proposal #{alert.metadata.proposal_id}
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-5">
                        <p className="text-sm">{new Date(alert.created_at).toLocaleTimeString()}</p>
                        <p className="text-[10px] text-zinc-500">{new Date(alert.created_at).toLocaleDateString()}</p>
                      </td>
                      <td className="px-6 py-5">
                        {alert.resolved ? (
                          <span className="flex items-center gap-1.5 text-emerald-500 text-xs font-semibold">
                            <CheckCircle2 className="w-4 h-4" /> Resolved
                          </span>
                        ) : (
                          <button 
                            onClick={() => resolveAlert(alert.id)}
                            className="bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-4 py-1.5 rounded-xl text-xs font-semibold transition-colors flex items-center gap-2"
                          >
                            Resolve
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ title, value, icon, color }: any) {
  return (
    <div className="bg-zinc-900/50 border border-zinc-800 p-6 rounded-3xl backdrop-blur-sm">
      <div className="flex items-center justify-between mb-4">
        <span className={`p-2 rounded-xl bg-zinc-800/50 border border-zinc-700/50 ${color}`}>
          {icon}
        </span>
      </div>
      <p className="text-zinc-500 text-sm font-medium mb-1 font-['Outfit']">{title}</p>
      <p className="text-3xl font-bold tracking-tight">{value}</p>
    </div>
  );
}
