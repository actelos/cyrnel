export interface EncryptedSecretsPayload {
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}
