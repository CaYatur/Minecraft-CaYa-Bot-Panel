import { Route, Routes } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Layout } from "./components/Layout";
import { BotDetail } from "./pages/BotDetail";
import { Dashboard } from "./pages/Dashboard";
import { Automations } from "./pages/Automations";
import { Schematics } from "./pages/Schematics";
import { Settings } from "./pages/Settings";
import { Servers } from "./pages/Servers";

export default function App() {
  return (
    <Layout>
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/bots/:id" element={<BotDetail />} />
          <Route path="/automations" element={<Automations />} />
          <Route path="/schematics" element={<Schematics />} />
          <Route path="/servers" element={<Servers />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </ErrorBoundary>
    </Layout>
  );
}
