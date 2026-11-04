import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AdminApp } from "./AdminApp";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from admin.html");

createRoot(root).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>,
);
