import { useCallback, useEffect, useState } from "react";
import type { Project } from "../types";
import { ImageIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { GhostButton } from "../components/Buttons";
import { useAuth, useUser } from "@clerk/clerk-react";
import api from "../configs/axios";
import toast from "react-hot-toast";
import { authHeaders } from "../utils/authHeaders";

const Result = () => {
    const { projectId } = useParams();
    const { getToken } = useAuth();
    const { user, isLoaded } = useUser();
    const navigate = useNavigate();

    const [project, setProjectData] = useState<Project>({} as Project);
    const [loading, setLoading] = useState(true);

    const fetchProjectData = useCallback(async () => {
        if (!projectId || !user) return null;

        const token = await getToken();
        const { data } = await api.get(`/api/user/projects/${projectId}`, {
            headers: authHeaders(token, user.id),
        });

        const next = data.project as Project;
        setProjectData(next);
        return next;
    }, [getToken, projectId, user]);

    useEffect(() => {
        if (!user || !projectId) {
            if (isLoaded && !user) navigate("/");
            return;
        }

        setLoading(true);
        fetchProjectData()
            .catch((error: any) => {
                toast.error(error?.response?.data?.message || error.message);
            })
            .finally(() => setLoading(false));

        const interval = setInterval(async () => {
            const next = await fetchProjectData().catch(() => null);
            if (next && (next.generatedImage || (!next.isGenerating && next.error))) {
                clearInterval(interval);
            }
        }, 3000);

        return () => clearInterval(interval);
    }, [user, projectId, isLoaded, fetchProjectData, navigate]);

    return loading ? (
        <div className="h-screen w-full flex items-center justify-center">
            <Loader2Icon className="animate-spin text-indigo- size-9" />
        </div>
    ) : (
        <div className="min-h-screen text-white p-6 md:p-12 mt-20">
            <div className="max-w-4xl mx-auto">
                <header className="flex justify-between items-center mb-8">
                    <h1 className="text-2xl md:text-3xl font-medium">Your Image</h1>
                    <Link to="/generate" className="btn-secondary text-sm flex items-center gap-2">
                        <RefreshCwIcon className="w-4 h-4" />
                        <p className="max-sm:hidden">New Generation</p>
                    </Link>
                </header>

                <div className="glass-panel p-2 rounded-2xl mb-6">
                    <div
                        className={`${project?.aspectRatio === "16:9" ? "aspect-video" : "aspect-9/16"} max-h-[70vh] mx-auto rounded-xl bg-gray-900 overflow-hidden relative`}
                    >
                        {project.isGenerating && !project.generatedImage ? (
                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/50 z-10">
                                <Loader2Icon className="size-10 animate-spin text-indigo-400" />
                                <p className="text-sm text-gray-200">Generating your image…</p>
                            </div>
                        ) : null}
                        {project?.generatedImage ? (
                            <img
                                src={project.generatedImage}
                                alt="Generated Result"
                                className="w-full h-full object-cover"
                            />
                        ) : (
                            <div className="w-full h-full min-h-80 flex flex-col items-center justify-center gap-3 p-6 text-center">
                                <ImageIcon className="size-8 text-gray-400" />
                                <p className="text-sm text-gray-300">
                                    {project.error || "Image generation failed"}
                                </p>
                            </div>
                        )}
                    </div>
                </div>

                <div className="glass-panel p-6 rounded-2xl">
                    <h3 className="text-xl font-semibold mb-4">Download</h3>
                    <a href={project.generatedImage?.replace("/upload", "/upload/fl_attachment")} download>
                        <GhostButton
                            disabled={!project.generatedImage}
                            className="w-full justify-center rounded-md py-3 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            <ImageIcon className="size-4.5" />
                            Download Image
                        </GhostButton>
                    </a>
                </div>
            </div>
        </div>
    );
};

export default Result;
