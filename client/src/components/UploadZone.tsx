import { useEffect, useId, useRef, useState } from "react";
import { UploadIcon, XIcon } from "lucide-react";
import toast from "react-hot-toast";
import type { UploadZoneProps } from "../types";

const MAX_FILE_BYTES = 12 * 1024 * 1024; // 12 MB
const ACCEPT = "image/jpeg,image/png,image/webp,image/gif";

const UploadZone = ({ label, file, onClear, onSelect }: UploadZoneProps) => {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }

    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const openFileDialog = () => {
    inputRef.current?.click();
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    e.target.value = "";

    if (!selected) return;

    if (!selected.type.startsWith("image/")) {
      toast.error("Please choose a JPEG, PNG, WebP, or GIF image.");
      return;
    }

    if (selected.size > MAX_FILE_BYTES) {
      toast.error("Image is too large. Please use a file under 12 MB.");
      return;
    }

    onSelect(selected);
  };

  return (
    <div className="relative group" data-lenis-prevent>
      <div
        className={`relative h-64 rounded-2xl border-2 border-dashed transition-colors duration-200 flex flex-col items-center justify-center bg-white/2 p-6 ${
          file
            ? "border-violet-600/50 bg-violet-500/5"
            : "border-white/10 hover:border-violet-500/30 hover:bg-white/5"
        }`}
      >
        {file && previewUrl ? (
          <>
            <img
              src={previewUrl}
              alt="preview"
              loading="lazy"
              decoding="async"
              className="absolute inset-0 w-full h-full object-cover rounded-xl opacity-60 pointer-events-none"
            />
            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/40 rounded-xl">
              <button
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onClear();
                }}
                className="p-2 rounded-full bg-white/10 hover:bg-red-500/20 text-white hover:text-red-400 transition-colors z-10"
              >
                <XIcon className="w-6 h-6" />
              </button>
            </div>
            <div className="absolute bottom-4 left-4 right-4 bg-black/60 p-3 rounded-lg border border-white/10 pointer-events-none z-10">
              <p className="text-sm font-medium truncate">{file.name}</p>
            </div>
            <button
              type="button"
              onClick={openFileDialog}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
              aria-label={`Replace ${label}`}
            />
          </>
        ) : (
          <button
            type="button"
            onClick={openFileDialog}
            className="flex flex-col items-center justify-center w-full h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50 rounded-xl"
          >
            <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
              <UploadIcon className="w-8 h-8 text-gray-400" />
            </div>
            <h3 className="text-lg font-semibold mb-2">{label}</h3>
            <p className="text-sm text-gray-400 text-center max-w-[200px]">
              Click to upload (max 12 MB)
            </p>
          </button>
        )}

        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={ACCEPT}
          onChange={handleInputChange}
          className="sr-only"
          tabIndex={-1}
        />
      </div>
    </div>
  );
};

export default UploadZone;
