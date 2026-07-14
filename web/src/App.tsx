import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { BotDetail } from "./pages/BotDetail";
import { Dashboard } from "./pages/Dashboard";
import { Automations, Settings } from "./pages/Placeholders";
import { Servers } from "./pages/Servers";

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/bots/:id" element={<BotDetail />} />
        <Route path="/automations" element={<Automations />} />
        <Route path="/servers" element={<Servers />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </Layout>
  );
}
