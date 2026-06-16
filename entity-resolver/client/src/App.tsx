import { createBrowserRouter, RouterProvider, NavLink, Outlet } from 'react-router';
import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, useIsMobile } from '@databricks/appkit-ui/react';
import { Menu, Activity, CheckCircle2, ListChecks, LayoutDashboard } from 'lucide-react';
import { DashboardPage } from './pages/DashboardPage';
import { QueuePage } from './pages/QueuePage';
import { ResolvePage } from './pages/ResolvePage';
import { DecisionsPage } from './pages/DecisionsPage';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
    isActive
      ? 'bg-[#FF3621] text-white'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
  }`;

const mobileNavLinkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
    isActive
      ? 'bg-[#FF3621] text-white'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
  }`;

function Layout() {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  const navItems = (linkClass: typeof navLinkClass) => (
    <>
      <NavLink to="/" end className={linkClass}>
        <LayoutDashboard className="h-4 w-4" />
        Overview
      </NavLink>
      <NavLink to="/queue" className={linkClass}>
        <ListChecks className="h-4 w-4" />
        Resolution Queue
      </NavLink>
      <NavLink to="/decisions" className={linkClass}>
        <CheckCircle2 className="h-4 w-4" />
        Decisions
      </NavLink>
    </>
  );

  return (
    <div className="min-h-screen bg-[#F9F7F4]">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-border bg-[#0B2026] text-white shadow-sm">
        <div className="mx-auto flex h-14 max-w-screen-xl items-center gap-4 px-4">
          {isMobile && (
            <button
              onClick={() => setOpen(true)}
              className="rounded-md p-1.5 hover:bg-white/10"
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </button>
          )}
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-[#FF3621]" />
            <span className="font-semibold tracking-tight">Entity Resolver</span>
            <span className="hidden text-xs text-white/50 sm:inline">
              Medical Facility Resolution
            </span>
          </div>
          {!isMobile && (
            <nav className="ml-6 flex items-center gap-1">
              {navItems(navLinkClass)}
            </nav>
          )}
        </div>
      </header>

      {/* Mobile nav drawer */}
      {isMobile && (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="left" className="w-64 bg-[#0B2026] text-white">
            <SheetHeader>
              <SheetTitle className="text-white">Navigation</SheetTitle>
            </SheetHeader>
            <nav className="mt-4 flex flex-col gap-1" onClick={() => setOpen(false)}>
              {navItems(mobileNavLinkClass)}
            </nav>
          </SheetContent>
        </Sheet>
      )}

      <main className="mx-auto max-w-screen-xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'queue', element: <QueuePage /> },
      { path: 'resolve/:clusterId', element: <ResolvePage /> },
      { path: 'decisions', element: <DecisionsPage /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
