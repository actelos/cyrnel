import { useEffect, useState } from "react";

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    const expectedUsername = import.meta.env.WEB_AUTH_USERNAME;
    const expectedPassword = import.meta.env.WEB_AUTH_PASSWORD;

    const enteredUsername = window.prompt("Username");
    const enteredPassword = window.prompt("Password");

    const matchesUsername = enteredUsername === expectedUsername;
    const matchesPassword = enteredPassword === expectedPassword;

    if (matchesUsername && matchesPassword) {
      setIsAuthenticated(true);
      return;
    }

    window.alert("Invalid credentials.");
  }, []);

  if (!isAuthenticated) {
    return null;
  }

  return (
    <div>
      <h1>Hello World</h1>
    </div>
  );
}

export default App;
