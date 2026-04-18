import type { SyntheticEvent } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();

    const expectedUsername = import.meta.env.VITE_AUTH_USERNAME;
    const expectedPassword = import.meta.env.VITE_AUTH_PASSWORD;

    if (!(expectedUsername && expectedPassword)) {
      setIsAuthenticated(false);
      setErrorMessage("Missing authentication configuration.");
      return;
    }

    const matchesUsername = username === expectedUsername;
    const matchesPassword = password === expectedPassword;

    if (matchesUsername && matchesPassword) {
      setErrorMessage("");
      setIsAuthenticated(true);
      return;
    }

    setIsAuthenticated(false);
    setErrorMessage("Invalid credentials. Please try again.");
  }

  if (!isAuthenticated) {
    return (
      <main className="flex h-screen items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>
              Enter your admin credentials to continue.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={handleSubmit}>
              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input
                  autoComplete="username"
                  id="username"
                  onChange={(event) => setUsername(event.target.value)}
                  required
                  value={username}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  autoComplete="current-password"
                  id="password"
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  type="password"
                  value={password}
                />
              </div>

              {errorMessage ? (
                <p className="text-destructive text-sm">{errorMessage}</p>
              ) : null}

              <Button className="w-full" type="submit">
                Login
              </Button>
            </form>
          </CardContent>
          <CardFooter>
            <p className="text-muted-foreground text-xs">
              This dashboard MUST be used in local environments use only
            </p>
          </CardFooter>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center">
      <h1>Hello World</h1>
    </main>
  );
}

export default App;
