import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import Home from "./pages/Home";
import Auth from "./pages/Auth";
import Dashboard from "./pages/Dashboard";
import CreatorDashboard from "./pages/CreatorDashboard";
import { DashboardLayout } from "./components/layout/DashboardLayout";
import NotFound from "./pages/NotFound";
import Subscriptions from "./pages/Subscriptions";
import Settings from "./pages/Settings";
import Creators from "./pages/Creators";
import CreatorProfile from "./pages/CreatorProfile";
import CreatorPosts from "./pages/CreatorPosts";
import CreatePost from "./pages/CreatePost";
import ConsentDashboard from "./pages/ConsentDashboard";
import ConsentSignPage from "./pages/ConsentSignPage";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/auth" element={<Auth />} />
            <Route path="/creators" element={<Creators />} />
            <Route path="/creators/:id" element={<CreatorProfile />} />
            <Route path="/consent/:token" element={<ConsentSignPage />} />
            <Route element={<ProtectedRoute />}>
              <Route path="/dashboard" element={<DashboardLayout />}>
                <Route index element={<Dashboard />} />
                <Route path="creator" element={<CreatorDashboard />} />
                <Route path="creator/posts" element={<CreatorPosts />} />
                <Route path="creator/posts/create" element={<CreatePost />} />
                <Route path="creator/consent" element={<ConsentDashboard />} />
                <Route path="subscriptions" element={<Subscriptions />} />
                <Route path="settings" element={<Settings />} />
              </Route>
            </Route>
            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
