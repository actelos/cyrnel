export interface EncryptedSecretsPayload {
  kid?: string;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}
