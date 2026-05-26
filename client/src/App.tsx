import Navbar from './components/Navbar';
import Home from './pages/Home';
import SoftBackdrop from './components/SoftBackdrop';
import Footer from './components/Footer';
import LenisScroll from './components/lenis';
import { Route, Routes, useLocation } from 'react-router-dom';
import Genetator from './pages/Genetator';
import Result from './pages/Result';
import MyGenerations from './pages/MyGenerations';
import Community from './pages/Community';
import Plans from './pages/Plans';
import Loading from './pages/Loading';
import {Toaster} from 'react-hot-toast'

function App() {
	const location = useLocation();
	const useSmoothScroll = location.pathname === '/';

	return (
		<>	
			<Toaster toastOptions={{style: {background: '#333', color: "#fff"}}}/>
			<SoftBackdrop />
			{useSmoothScroll ? <LenisScroll /> : null}
			<Navbar />

			<Routes>
				<Route path='/' element={<Home />}/>
				<Route path='/generate' element={<Genetator />}/>
				<Route path='/result/:projectId' element={<Result />}/>
				<Route path='/my-generations' element={<MyGenerations />}/>
				<Route path='/community' element={<Community />}/>
				<Route path='/plans' element={<Plans />}/>
				<Route path='/loading' element={<Loading />}/>
				
			</Routes>

			<Footer />
		</>
	);
}
export default App;