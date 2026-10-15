// Shared app state (filled after login)
export const state = {
  session: null,
  email: null,
  profile: null,      // row from app_users
  steps: [],          // all steps ordered
  users: [],          // all app_users
  pendingCount: 0,
};

export const isAdmin = () => state.profile?.role === "ADMIN";
export const isSales = () => state.profile?.role === "SALES" || isAdmin();
export const stepOf = (code) => state.steps.find((s) => s.step_code === code);
export const prevStepOf = (code) => state.steps.find((s) => s.next_step_code === code);
export const userName = (email) => state.users.find((u) => u.email === email)?.full_name ?? email;
